import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { DeliveryTaskView, StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { callSession, courier, courierPosition, courierShift, customer, deliveryTask, kdsItem, order, orderItem, outbox, pickTask, product, store, userStaff } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { distanceM, travelMinutes, type Geo } from '../../shared/geo.js';
import { eventTime } from '../../shared/event-time.js';
import { loadParams } from '../../shared/params/load.js';
import { setCaptured, transition } from '../orders/index.js';
import { markCustomerDelivered } from '../customers/index.js';
import { captureAmountNow } from '../payments/index.js';
import { returnPickedItems } from '../wms/index.js';
import { courierCallStats } from '../calls/index.js';
import { payoutForEndedShift } from './shift-summary.js';
import { planDispatch, type FreeCourier, type PendingOrder } from './planner.js';
import { courierMachine, taskMachine } from './state-machine.js';

/** Диспетчер и приложение курьера (ТЗ §6, §4). */

const TASK_ACTIVE = ['offered', 'accepted', 'at_store', 'picked_up', 'delivering'] as const;

export async function courierOf(tx: Tx, me: StaffPrincipal) {
  const [c] = await tx.select().from(courier).where(eq(courier.staffId, me.staff_id)).for('update');
  if (!c) throw new AppError('FORBIDDEN', 'Сотрудник не курьер');
  return c;
}

async function setCourierStatus(tx: Tx, c: typeof courier.$inferSelect, to: typeof c.status, by: 'courier' | 'system' | 'shift_lead') {
  if (c.status === to) return;
  courierMachine.assert(c.status, to, by);
  await tx.update(courier).set({ status: to }).where(eq(courier.id, c.id));
  await publish(tx, { topic: 'courier.status_changed', aggregateType: 'courier', aggregateId: c.id, payload: { from: c.status, to } });
  c.status = to;
}

async function setTaskStatus(tx: Tx, t: typeof deliveryTask.$inferSelect, to: typeof t.status, by: 'courier' | 'system' | 'shift_lead', patch: Partial<typeof deliveryTask.$inferInsert> = {}) {
  taskMachine.assert(t.status, to, by);
  await tx.update(deliveryTask).set({ status: to, ...patch }).where(eq(deliveryTask.id, t.id));
  t.status = to;
}

// ---------- смена ----------

export async function selfView(deps: AppDeps, me: StaffPrincipal) {
  return deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const [shift] = await tx.select().from(courierShift).where(and(eq(courierShift.courierId, c.id), isNull(courierShift.endedAt))).orderBy(desc(courierShift.startedAt)).limit(1);
    const dayStart = new Date(deps.clock.now());
    dayStart.setUTCHours(dayStart.getUTCHours() - 5 - (dayStart.getUTCHours() - 5 + 24) % 24, 0, 0, 0); // начало суток Asia/Dushanbe (UTC+5)
    const [cnt] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .innerJoin(deliveryTask, sql`${order.id} = any(${deliveryTask.orderIds})`)
      .where(and(eq(deliveryTask.courierId, c.id), eq(order.status, 'delivered'), gt(order.deliveredAt, dayStart)));
    return {
      courier_id: c.id,
      status: c.status,
      transport: c.transport,
      store_id: c.currentStoreId,
      shift_started_at: shift?.startedAt?.toISOString() ?? null,
      deliveries_today: cnt?.n ?? 0,
    };
  });
}

export async function shiftStart(deps: AppDeps, me: StaffPrincipal, transport?: 'foot' | 'bike' | 'moto') {
  if (!me.store_id) throw new AppError('FORBIDDEN', 'Курьер не привязан к точке');
  await deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    if (c.status !== 'offline') throw new AppError('INVALID_TRANSITION', 'Смена уже открыта');
    await tx.insert(courierShift).values({ courierId: c.id, storeId: me.store_id!, startedAt: deps.clock.now() });
    await tx.update(courier).set({ currentStoreId: me.store_id, ...(transport ? { transport } : {}) }).where(eq(courier.id, c.id));
    await setCourierStatus(tx, c, 'free', 'courier');
  });
  return selfView(deps, me);
}

export async function shiftEnd(deps: AppDeps, me: StaffPrincipal) {
  const courierId = await deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const active = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.courierId, c.id), inArray(deliveryTask.status, [...TASK_ACTIVE])));
    if (active.length) throw new AppError('INVALID_TRANSITION', 'Нельзя закрыть смену с активным заданием', { task_ids: active.map((t) => t.id) });
    if (c.status === 'break') await setCourierStatus(tx, c, 'free', 'courier');
    if (c.status === 'returning') await setCourierStatus(tx, c, 'free', 'courier');
    await setCourierStatus(tx, c, 'offline', 'courier');
    await tx.update(courierShift).set({ endedAt: deps.clock.now() }).where(and(eq(courierShift.courierId, c.id), isNull(courierShift.endedAt)));
    return c.id;
  });
  // оплата за смену — на кошелёк DC (только безналично); отправит воркер
  await payoutForEndedShift(deps, courierId);
  return selfView(deps, me);
}

export async function shiftBreak(deps: AppDeps, me: StaffPrincipal) {
  await deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    await setCourierStatus(tx, c, c.status === 'break' ? 'free' : 'break', 'courier');
  });
  return selfView(deps, me);
}

/** Пакет точек; принимаются по времени события, не получения (ТЗ §11). Возврат на точку → free. */
export async function positions(deps: AppDeps, me: StaffPrincipal, points: { lat: number; lon: number; at: string; accuracy_m: number }[]) {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const rows = points
      .map((p) => ({ courierId: c.id, lat: p.lat, lon: p.lon, at: new Date(p.at), accuracyM: p.accuracy_m }))
      .filter((p) => p.at.getTime() <= now.getTime() + 60_000);
    if (rows.length) await tx.insert(courierPosition).values(rows);
    const last = rows.sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
    if (last && c.status === 'returning' && c.currentStoreId) {
      const [st] = await tx.select().from(store).where(eq(store.id, c.currentStoreId));
      if (st && distanceM(last, st) <= 100) await setCourierStatus(tx, c, 'free', 'system');
    }
  });
  return { accepted: points.length };
}

// ---------- задания курьера ----------

async function taskView(tx: Tx, t: typeof deliveryTask.$inferSelect): Promise<DeliveryTaskView> {
  const P = await loadParams(tx, t.storeId);
  const [st] = await tx.select().from(store).where(eq(store.id, t.storeId));
  const orders = t.orderIds.length ? await tx.select().from(order).where(inArray(order.id, t.orderIds)) : [];
  const items = orders.length
    ? await tx
        .select({ orderId: orderItem.orderId, tempZone: product.tempZone, status: orderItem.status })
        .from(orderItem)
        .innerJoin(product, eq(product.id, orderItem.productId))
        .where(inArray(orderItem.orderId, t.orderIds))
    : [];
  const sessions = t.orderIds.length
    ? await tx.select().from(callSession).where(and(inArray(callSession.orderId, t.orderIds), eq(callSession.courierId, t.courierId), isNull(callSession.closedAt)))
    : [];
  const masked = orders.length
    ? await tx.select({ id: customer.id, m: customer.phoneMasked }).from(customer).where(inArray(customer.id, orders.map((o) => o.customerId)))
    : [];
  const calls = new Map<string, Awaited<ReturnType<typeof courierCallStats>>>();
  for (const o of orders) calls.set(o.id, await courierCallStats(tx, o.id));
  return {
    task_id: t.id,
    status: t.status,
    store: { id: st!.id, name: st!.name, address: st!.address, geo: { lat: st!.lat, lon: st!.lon } },
    assigned_at: t.assignedAt.toISOString(),
    offer_expires_at: t.status === 'offered' ? new Date(t.assignedAt.getTime() + P.OFFER_TIMEOUT_MS).toISOString() : null,
    orders: orders.map((o) => {
      const a = o.addressSnapshot as Record<string, unknown>;
      return {
        order_id: o.id,
        number: o.number,
        brand: o.brand,
        status: o.status,
        package_barcode: `PKG-${o.number}`,
        temp_zones: [...new Set(items.filter((i) => i.orderId === o.id && i.status === 'picked').map((i) => i.tempZone))],
        address: {
          street: String(a['street'] ?? ''),
          house: String(a['house'] ?? ''),
          entrance: (a['entrance'] as string | null) ?? null,
          floor: (a['floor'] as string | null) ?? null,
          flat: (a['flat'] as string | null) ?? null,
          comment: (a['comment'] as string | null) ?? null,
          geo: { lat: Number(a['lat']), lon: Number(a['lon']) },
        },
        customer_phone_masked: masked.find((m) => m.id === o.customerId)?.m ?? null,
        call_number: sessions.find((x) => x.orderId === o.id)?.numberForCourier ?? null,
        calls_made: calls.get(o.id)?.count ?? 0,
        first_call_at: calls.get(o.id)?.firstAt?.toISOString() ?? null,
        promised_at: o.promisedAt?.toISOString() ?? null,
        total_dirams: o.totalDirams,
      };
    }),
  };
}

export async function currentTask(deps: AppDeps, me: StaffPrincipal) {
  return deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const [t] = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.courierId, c.id), inArray(deliveryTask.status, [...TASK_ACTIVE]))).orderBy(asc(deliveryTask.assignedAt)).limit(1);
    return t ? taskView(tx, t) : null;
  });
}

async function loadTask(tx: Tx, c: typeof courier.$inferSelect, taskId: string) {
  const [t] = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.id, taskId), eq(deliveryTask.courierId, c.id))).for('update');
  if (!t) throw notFound('Задание', taskId);
  return t;
}

export async function accept(deps: AppDeps, me: StaffPrincipal, taskId: string) {
  return deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const t = await loadTask(tx, c, taskId);
    if (t.status === 'offered') {
      await setTaskStatus(tx, t, 'accepted', 'courier');
      await publish(tx, { topic: 'task.accepted', aggregateType: 'delivery_task', aggregateId: t.id, payload: { courier_id: c.id } });
    }
    return taskView(tx, t);
  });
}

/** Скан ярлыков всех пакетов задания → заказы on_the_way, курьер delivering (ТЗ §3, §4). */
export async function pickup(deps: AppDeps, me: StaffPrincipal, taskId: string, barcodes: string[], rawAt?: string) {
  return deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const t = await loadTask(tx, c, taskId);
    if (!['accepted', 'at_store', 'offered'].includes(t.status)) throw new AppError('INVALID_TRANSITION', `Задание в статусе ${t.status}`);
    const orders = await tx.select().from(order).where(inArray(order.id, t.orderIds)).for('update');
    const notReady = orders.filter((o) => o.status !== 'ready');
    if (notReady.length) throw new AppError('INVALID_TRANSITION', 'Не все заказы готовы', { order_numbers: notReady.map((o) => o.number) });
    const expected = new Set(orders.map((o) => `PKG-${o.number}`));
    const missing = [...expected].filter((b) => !barcodes.includes(b));
    const extra = barcodes.filter((b) => !expected.has(b));
    if (missing.length || extra.length) throw new AppError('WRONG_PRODUCT', 'Отсканируйте ярлыки всех пакетов задания', { missing, extra });
    if (t.status === 'offered') await setTaskStatus(tx, t, 'accepted', 'courier');
    if (t.status === 'accepted') await setTaskStatus(tx, t, 'at_store', 'courier');
    const at = eventTime(deps.clock.now(), rawAt, t.assignedAt);
    await setTaskStatus(tx, t, 'picked_up', 'courier', { pickedUpAt: at });
    await setTaskStatus(tx, t, 'delivering', 'courier');
    for (const o of orders) await transition(tx, o.id, 'ready', 'on_the_way', 'staff', me.staff_id, { task_id: t.id, ...eventMeta(deps, rawAt) }, at);
    await setCourierStatus(tx, c, 'delivering', 'courier');
    return taskView(tx, t);
  });
}

/** Подтверждение у двери курьером: только внутри геозоны адреса (ТЗ §11). */
export async function delivered(deps: AppDeps, me: StaffPrincipal, orderId: string, geo: Geo, photoUrl?: string, rawAt?: string) {
  const result = await deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const [t] = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.courierId, c.id), eq(deliveryTask.status, 'delivering'), sql`${orderId} = any(${deliveryTask.orderIds})`)).for('update');
    if (!t) throw notFound('Задание с этим заказом', orderId);
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    const P = await loadParams(tx, o.storeId);
    const dist = distanceM(geo, o.addressSnapshot as { lat: number; lon: number });
    if (dist > P.DELIVERY_GEOFENCE_M) {
      throw new AppError('TOO_FAR_FROM_ADDRESS', 'Слишком далеко от адреса — подтвердить может старший смены', { distance_m: Math.round(dist), geofence_m: P.DELIVERY_GEOFENCE_M });
    }
    const at = eventTime(deps.clock.now(), rawAt, t.pickedUpAt);
    return finishDelivery(tx, deps, t, c, o, me.staff_id, { distance_m: Math.round(dist), photo_url: photoUrl ?? null, ...eventMeta(deps, rawAt) }, at);
  });
  // списание — вне транзакции заказа; при неуспехе повтор по расписанию (воркер payments.capture)
  const cap = await captureAmountNow(deps, result.orderId, result.amount);
  return { order_id: result.orderId, captured: cap?.ok ?? false, task_status: result.task.status };
}

/** Доставлено вне геозоны: подтверждает только старший смены с причиной (ТЗ §11); пишется в журнал вызывающим. */
export async function confirmDeliveredByLead(deps: AppDeps, me: StaffPrincipal, orderId: string, reason: string) {
  const result = await deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (me.store_id && me.store_id !== o.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
    const [t] = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.status, 'delivering'), sql`${orderId} = any(${deliveryTask.orderIds})`)).for('update');
    if (!t) throw new AppError('INVALID_TRANSITION', 'Заказ не в пути');
    const [c] = await tx.select().from(courier).where(eq(courier.id, t.courierId)).for('update');
    return finishDelivery(tx, deps, t, c!, o, me.staff_id, { override: true, reason, confirmed_by: me.staff_id });
  });
  const cap = await captureAmountNow(deps, result.orderId, result.amount);
  return { order_id: result.orderId, captured: cap?.ok ?? false, task_status: result.task.status };
}

async function finishDelivery(
  tx: Tx,
  deps: AppDeps,
  t: typeof deliveryTask.$inferSelect,
  c: typeof courier.$inferSelect,
  o: typeof order.$inferSelect,
  actorId: string,
  meta: Record<string, unknown>,
  at: Date = deps.clock.now(),
) {
  await transition(tx, o.id, o.status, 'delivered', 'staff', actorId, meta, at);
  await setCaptured(tx, o.id, o.totalDirams);
  await markCustomerDelivered(tx, o.customerId, at);
  const rest = await tx.select().from(order).where(and(inArray(order.id, t.orderIds), eq(order.status, 'on_the_way')));
  if (rest.length === 0) {
    await setTaskStatus(tx, t, 'done', 'system', { finishedAt: at });
    await setCourierStatus(tx, c, 'returning', 'system');
  }
  return { orderId: o.id, amount: o.totalDirams, task: t };
}

/** Клиент не вышел: 2 звонка и ожидание → returning (ТЗ §11). */
export async function noShow(deps: AppDeps, me: StaffPrincipal, orderId: string, comment?: string, rawAt?: string) {
  return deps.db.transaction(async (tx) => {
    const c = await courierOf(tx, me);
    const [t] = await tx.select().from(deliveryTask).where(and(eq(deliveryTask.courierId, c.id), eq(deliveryTask.status, 'delivering'), sql`${orderId} = any(${deliveryTask.orderIds})`)).for('update');
    if (!t) throw notFound('Задание с этим заказом', orderId);
    const at = eventTime(deps.clock.now(), rawAt, t.pickedUpAt);
    // ТЗ §11: 2 звонка через подменный номер и ожидание NO_SHOW_WAIT от первого — проверяет сервер, не кнопка
    const P = await loadParams(tx, t.storeId);
    const calls = await courierCallStats(tx, orderId);
    if (calls.count < 2) throw new AppError('INVALID_TRANSITION', 'Сначала позвоните клиенту 2 раза из приложения', { calls_made: calls.count });
    const waitedMs = at.getTime() - calls.firstAt!.getTime();
    if (waitedMs < P.NO_SHOW_WAIT_MS)
      throw new AppError('INVALID_TRANSITION', `Подождите у двери ещё ${Math.ceil((P.NO_SHOW_WAIT_MS - waitedMs) / 60_000)} мин`, { wait_left_sec: Math.ceil((P.NO_SHOW_WAIT_MS - waitedMs) / 1000) });
    await transition(tx, orderId, 'on_the_way', 'returning', 'staff', me.staff_id, { comment: comment ?? null, calls_made: calls.count, ...eventMeta(deps, rawAt) }, at);
    const rest = await tx.select().from(order).where(and(inArray(order.id, t.orderIds), eq(order.status, 'on_the_way')));
    if (rest.length === 0) {
      await setTaskStatus(tx, t, 'failed', 'courier', { finishedAt: at });
      await setCourierStatus(tx, c, 'returning', 'system');
    }
    return taskView(tx, t);
  });
}

/**
 * Пакет принят на точке (старший смены): LAB — товар на полку (новая партия без ячейки), охлаждённое и замороженное — в списание;
 * списывается доставка, товар нет. SOR — полная сумма (ТЗ §11).
 */
export async function markReturned(deps: AppDeps, me: StaffPrincipal, orderId: string, comment?: string) {
  const r = await deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (me.store_id && me.store_id !== o.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
    await transition(tx, o.id, 'returning', 'returned', 'staff', me.staff_id, { comment: comment ?? null });
    if (o.brand === 'LAB') await returnPickedItems(tx, o.storeId, o.id, me.staff_id);
    const amount = o.brand === 'LAB' ? o.deliveryFeeDirams : o.totalDirams;
    await setCaptured(tx, o.id, amount, 'клиент не вышел');
    return { amount };
  });
  await captureAmountNow(deps, orderId, r.amount);
  return { order_id: orderId, captured_dirams: r.amount };
}

// ---------- диспетчер (воркер и ручное назначение) ----------

/** Собрать вход планировщика по точке и применить план в транзакции. Возвращает число назначений. */
export async function dispatchStore(deps: AppDeps, storeId: string): Promise<{ assigned: number; alerts: number }> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const P = await loadParams(tx, storeId);
    const [st] = await tx.select().from(store).where(eq(store.id, storeId));
    if (!st) return { assigned: 0, alerts: 0 };

    // истёкшие предложения → expired, курьер снова free
    const expired = await tx
      .select()
      .from(deliveryTask)
      .where(and(eq(deliveryTask.storeId, storeId), eq(deliveryTask.status, 'offered'), sql`${deliveryTask.assignedAt} < ${new Date(now.getTime() - P.OFFER_TIMEOUT_MS)}`))
      .for('update');
    for (const t of expired) {
      await setTaskStatus(tx, t, 'expired', 'system', { finishedAt: now });
      const [c] = await tx.select().from(courier).where(eq(courier.id, t.courierId)).for('update');
      if (c && c.status === 'assigned') await setCourierStatus(tx, c, 'free', 'system');
      await publish(tx, { topic: 'task.expired', aggregateType: 'delivery_task', aggregateId: t.id, payload: { courier_id: t.courierId, order_ids: t.orderIds } });
    }

    // задания, все заказы которых уже отменены (например, отмена прошла в обход сервиса) — закрываем
    const stale = await tx.execute<{ order_id: string }>(sql`
      select o.id order_id from delivery_task t join "order" o on o.id = any(t.order_ids)
      where t.store_id = ${storeId} and t.status in ('offered','accepted','at_store') and o.status in ('cancelled','payment_failed')`);
    for (const r of stale.rows) await detachOrder(tx, r.order_id, 'заказ отменён');

    const busyOrders = tx.select({ id: sql<string>`unnest(${deliveryTask.orderIds})` }).from(deliveryTask).where(inArray(deliveryTask.status, [...TASK_ACTIVE]));
    const candidates = await tx
      .select()
      .from(order)
      .where(and(eq(order.storeId, storeId), inArray(order.status, ['paid_hold', 'picking', 'cooking', 'ready']), notInArray(order.id, busyOrders)))
      .for('update', { skipLocked: true });

    const toPending = async (o: typeof order.$inferSelect): Promise<PendingOrder> => {
      let readyEta: Date;
      if (o.status === 'ready') readyEta = now;
      else if (o.brand === 'LAB') {
        const [pt] = await tx.select().from(pickTask).where(eq(pickTask.orderId, o.id));
        readyEta = new Date((pt?.startedAt ?? now).getTime() + P.LAB_PICK_SLA_MS);
        // блюдо кухни в заказе Lablabu: заказ готов не раньше блюда (этап 2 ТЗ §8)
        const [k] = await tx.select({ t: sql<Date | null>`max(${kdsItem.targetReadyAt})` }).from(kdsItem).where(eq(kdsItem.orderId, o.id));
        if (k?.t && new Date(k.t) > readyEta) readyEta = new Date(k.t);
      } else {
        const [k] = await tx.select({ t: sql<Date>`max(${kdsItem.targetReadyAt})` }).from(kdsItem).where(eq(kdsItem.orderId, o.id));
        readyEta = k?.t ? new Date(k.t) : new Date(now.getTime() + P.SOR_PROMISE_MS);
      }
      // снят вручную с курьера (не отвечает, сломался транспорт…) — 15 минут этому курьеру его не даём
      const removed = await tx
        .select({ c: deliveryTask.courierId })
        .from(deliveryTask)
        .where(and(eq(deliveryTask.status, 'reassigned'), sql`${o.id} = any(${deliveryTask.orderIds})`, gt(deliveryTask.finishedAt, new Date(now.getTime() - UNASSIGN_COOLDOWN_MS))));
      return {
        id: o.id,
        brand: o.brand,
        createdAt: o.createdAt,
        readyEta,
        ...(removed.length ? { excludeCourierIds: removed.map((r) => r.c) } : {}),
        promisedAt: o.promisedAt ?? new Date(now.getTime() + P.LAB_PROMISE_MS),
        address: o.addressSnapshot as { lat: number; lon: number },
        readyAt: o.readyAt,
      };
    };
    const pending: PendingOrder[] = [];
    for (const o of candidates) {
      if (o.brand === 'LAB' && o.status === 'paid_hold') continue; // LAB ждёт сборщика; диспетчер запускается с picking (ТЗ §6)
      pending.push(await toPending(o));
    }

    // открытые задания курьеров, ещё не уехавших с точки: к ним можно подсадить заказ (этап 2 ТЗ §6)
    const open = await tx
      .select({ t: deliveryTask, transport: courier.transport })
      .from(deliveryTask)
      .innerJoin(courier, eq(courier.id, deliveryTask.courierId))
      .where(and(eq(deliveryTask.storeId, storeId), inArray(deliveryTask.status, ['offered', 'accepted', 'at_store'])))
      .for('update', { of: deliveryTask, skipLocked: true });
    const openTrips = [];
    for (const { t, transport } of open) {
      const os = t.orderIds.length ? await tx.select().from(order).where(inArray(order.id, t.orderIds)) : [];
      const ordered = t.orderIds.map((id) => os.find((o) => o.id === id)).filter((o): o is typeof order.$inferSelect => !!o);
      openTrips.push({ taskId: t.id, courierId: t.courierId, transport, orders: await Promise.all(ordered.map(toPending)) });
    }

    const couriers = await tx
      .select({ c: courier })
      .from(courier)
      .where(and(eq(courier.currentStoreId, storeId), inArray(courier.status, ['free', 'returning'])))
      .for('update');
    const free: FreeCourier[] = [];
    for (const { c } of couriers) {
      const [pos] = await tx.select().from(courierPosition).where(eq(courierPosition.courierId, c.id)).orderBy(desc(courierPosition.at)).limit(1);
      const position = pos ? { lat: pos.lat, lon: pos.lon } : { lat: st.lat, lon: st.lon };
      const etaToStoreMin = c.status === 'returning' ? travelMinutes(position, st, c.transport) : 0;
      free.push({ id: c.id, transport: c.transport, position, etaToStoreMin });
    }

    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.brand, 'LAB'), gt(order.createdAt, new Date(now.getTime() - 5 * 60_000))));

    const plan = planDispatch({ now, store: st, orders: pending, couriers: free, labDemandRecent: (recent?.n ?? 0) > 0, openTrips, params: P });

    // одно задание на поездку: новое — при первом назначении курьеру в этом тике, дальше — порядок доставки обновляется
    const taskOf = new Map<string, string>();
    for (const a of plan.assignments) {
      const existing = a.taskId ?? taskOf.get(a.courierId);
      const snap = { rule: a.rule, slack_min: a.slackMin, travel_min: a.travelMin, detour_min: a.detourMin ?? null, sequence: a.sequence, input: plan.snapshot };
      if (existing) {
        await tx.update(deliveryTask).set({ orderIds: a.sequence, dispatchSnapshot: JSON.stringify(snap) }).where(eq(deliveryTask.id, existing));
        await publish(tx, { topic: 'task.offered', aggregateType: 'delivery_task', aggregateId: existing, payload: { courier_id: a.courierId, order_id: a.orderId, rule: a.rule, batched: true } });
        continue;
      }
      const [c] = await tx.select().from(courier).where(eq(courier.id, a.courierId)).for('update');
      if (!c) continue;
      const [t] = await tx
        .insert(deliveryTask)
        .values({
          courierId: c.id,
          storeId,
          status: P.AUTO_ACCEPT ? 'accepted' : 'offered',
          orderIds: a.sequence,
          assignedAt: now,
          assignedBy: 'auto',
          dispatchSnapshot: JSON.stringify(snap),
        })
        .returning();
      taskOf.set(c.id, t!.id);
      await setCourierStatus(tx, c, 'assigned', 'system');
      await publish(tx, { topic: 'task.offered', aggregateType: 'delivery_task', aggregateId: t!.id, payload: { courier_id: c.id, order_id: a.orderId, rule: a.rule, auto_accept: P.AUTO_ACCEPT } });
    }

    let alerts = 0;
    for (const al of plan.alerts) {
      // не повторять одну и ту же тревогу чаще раза в 5 минут
      const [dup] = await tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(eq(outbox.topic, 'dispatch.no_courier'), eq(outbox.aggregateId, al.orderId), sql`${outbox.payload}->>'level' = ${al.level}`, gt(outbox.createdAt, new Date(now.getTime() - 5 * 60_000))))
        .limit(1);
      if (dup) continue;
      await publish(tx, { topic: 'dispatch.no_courier', aggregateType: 'order', aggregateId: al.orderId, payload: { level: al.level, waiting_min: al.waitingMin, store_id: storeId } });
      alerts++;
    }
    return { assigned: plan.assignments.length, alerts };
  });
}

/**
 * Заказ отменён до выезда: снять его с задания курьера. Пустое задание закрывается, курьер снова свободен.
 * После pickup заказ отменить нельзя (машина состояний), поэтому трогаем только offered / accepted / at_store.
 */
export async function detachOrder(tx: Tx, orderId: string, reason: string) {
  const [t] = await tx
    .select()
    .from(deliveryTask)
    .where(and(inArray(deliveryTask.status, ['offered', 'accepted', 'at_store']), sql`${orderId} = any(${deliveryTask.orderIds})`))
    .for('update');
  if (!t) return;
  const rest = t.orderIds.filter((id) => id !== orderId);
  if (rest.length) {
    await tx.update(deliveryTask).set({ orderIds: rest }).where(eq(deliveryTask.id, t.id));
    return;
  }
  if (t.status === 'offered') await setTaskStatus(tx, t, 'expired', 'system', { finishedAt: new Date(), overrideReason: reason });
  else await setTaskStatus(tx, t, 'reassigned', 'shift_lead', { finishedAt: new Date(), overrideReason: reason });
  const [c] = await tx.select().from(courier).where(eq(courier.id, t.courierId)).for('update');
  if (c?.status === 'assigned') await setCourierStatus(tx, c, 'free', 'system');
}

/** Сколько заказ, снятый с курьера вручную, не предлагается тому же курьеру. */
const UNASSIGN_COOLDOWN_MS = 15 * 60_000;

/** Снять заказ с курьера (ТЗ §6): заказ возвращается в очередь диспетчера. Курьер в пути — только отмена/возврат. */
export async function unassign(deps: AppDeps, me: StaffPrincipal, orderId: string, reason: string) {
  return deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (me.store_id && me.store_id !== o.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
    const [t] = await tx.select().from(deliveryTask).where(and(inArray(deliveryTask.status, [...TASK_ACTIVE]), sql`${orderId} = any(${deliveryTask.orderIds})`));
    if (!t) throw new AppError('INVALID_TRANSITION', 'Заказ не назначен курьеру');
    if (!['offered', 'accepted', 'at_store'].includes(t.status)) throw new AppError('INVALID_TRANSITION', 'Курьер уже забрал заказ — снять нельзя');
    await detachOrder(tx, orderId, reason);
    return { courier_id: t.courierId, task_id: t.id };
  });
}

/** Ручное назначение или переназначение старшим смены — причина обязательна, пишется в задание (ТЗ §6). */
export async function manualAssign(deps: AppDeps, me: StaffPrincipal, orderId: string, courierId: string, reason: string) {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (me.store_id && me.store_id !== o.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
    if (!['picking', 'cooking', 'ready', 'paid_hold'].includes(o.status)) throw new AppError('INVALID_TRANSITION', `Заказ в статусе ${o.status} нельзя назначить`);
    const [c] = await tx.select().from(courier).where(eq(courier.id, courierId)).for('update');
    if (!c) throw notFound('Курьер', courierId);
    if (!['free', 'returning', 'assigned'].includes(c.status)) throw new AppError('INVALID_TRANSITION', `Курьер в статусе ${c.status}`);

    // снять заказ с текущего задания, если есть
    const [cur] = await tx.select().from(deliveryTask).where(and(inArray(deliveryTask.status, ['offered', 'accepted', 'at_store']), sql`${orderId} = any(${deliveryTask.orderIds})`)).for('update');
    if (cur) {
      const rest = cur.orderIds.filter((id) => id !== orderId);
      if (rest.length) await tx.update(deliveryTask).set({ orderIds: rest }).where(eq(deliveryTask.id, cur.id));
      else {
        await setTaskStatus(tx, cur, 'reassigned', 'shift_lead', { finishedAt: now, overrideReason: reason });
        const [pc] = await tx.select().from(courier).where(eq(courier.id, cur.courierId)).for('update');
        if (pc && pc.status === 'assigned' && pc.id !== c.id) await setCourierStatus(tx, pc, 'free', 'shift_lead');
      }
    }
    const [t] = await tx
      .insert(deliveryTask)
      .values({ courierId: c.id, storeId: o.storeId, status: 'accepted', orderIds: [orderId], assignedAt: now, assignedBy: 'manual', overrideReason: reason, dispatchSnapshot: JSON.stringify({ by: me.staff_id, reason }) })
      .returning();
    if (c.status !== 'assigned') await setCourierStatus(tx, c, 'assigned', 'shift_lead');
    return taskView(tx, t!);
  });
}

export async function consoleCouriers(deps: AppDeps, storeId: string) {
  const rows = await deps.db
    .select({ c: courier, name: userStaff.name })
    .from(courier)
    .innerJoin(userStaff, eq(userStaff.id, courier.staffId))
    .where(eq(courier.currentStoreId, storeId));
  const out = [];
  for (const { c, name } of rows) {
    const [pos] = await deps.db.select().from(courierPosition).where(eq(courierPosition.courierId, c.id)).orderBy(desc(courierPosition.at)).limit(1);
    const [t] = await deps.db.select({ id: deliveryTask.id }).from(deliveryTask).where(and(eq(deliveryTask.courierId, c.id), inArray(deliveryTask.status, [...TASK_ACTIVE]))).limit(1);
    out.push({
      courier_id: c.id,
      name,
      status: c.status,
      transport: c.transport,
      position: pos ? { lat: pos.lat, lon: pos.lon } : null,
      position_at: pos?.at.toISOString() ?? null,
      current_task_id: t?.id ?? null,
    });
  }
  return { couriers: out };
}

/** Курьер по заказу — для пульта и витрины. */
export async function courierForOrder(tx: Tx, orderId: string) {
  const [row] = await tx
    .select({ t: deliveryTask, name: userStaff.name })
    .from(deliveryTask)
    .innerJoin(courier, eq(courier.id, deliveryTask.courierId))
    .innerJoin(userStaff, eq(userStaff.id, courier.staffId))
    .where(and(inArray(deliveryTask.status, [...TASK_ACTIVE, 'done']), sql`${orderId} = any(${deliveryTask.orderIds})`))
    .orderBy(desc(deliveryTask.assignedAt))
    .limit(1);
  if (!row) return null;
  const [pos] = await tx.select().from(courierPosition).where(eq(courierPosition.courierId, row.t.courierId)).orderBy(desc(courierPosition.at)).limit(1);
  return { courier_id: row.t.courierId, name: row.name, task_status: row.t.status, position: pos ? { lat: pos.lat, lon: pos.lon } : null };
}

/** Для журнала статусов: когда событие случилось на устройстве и когда дошло до сервера. */
function eventMeta(deps: AppDeps, rawAt: string | undefined) {
  return rawAt ? { event_at: rawAt, received_at: deps.clock.now().toISOString() } : {};
}
