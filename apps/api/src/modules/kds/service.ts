import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { StaffPrincipal, Station } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { kdsItem, order, orderItem, stopList } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { loadParams } from '../../shared/params/load.js';
import { getDishes } from '../catalog/index.js';
import { markAllItemsPicked, setPromisedAt, transition } from '../orders/index.js';
import { consumeIngredients } from '../wms/index.js';
import { dishColor, scheduleOrder, sorPromise, type StationLoad } from './schedule.js';

/** Кухня Sor Box (ТЗ §8): раскладка заказа по станциям, очередь, упаковка, стоп-лист. */

const STATIONS = ['pizza', 'grill', 'cold', 'pack'] as const;

const storeOf = (me: StaffPrincipal): string => {
  if (!me.store_id) throw new AppError('FORBIDDEN', 'Сотрудник не привязан к точке');
  return me.store_id;
};

/** Загрузка станций: в работе и сколько секунд до освобождения слота (эвристика первого этапа). */
async function stationLoad(tx: Tx, storeId: string, now: Date): Promise<StationLoad> {
  const params = await loadParams(tx, storeId);
  const rows = await tx
    .select()
    .from(kdsItem)
    .where(and(eq(kdsItem.storeId, storeId), isNull(kdsItem.doneAt)));
  const load = {} as StationLoad;
  for (const s of STATIONS) {
    const mine = rows.filter((r) => r.station === s);
    const inProgress = mine.filter((r) => r.startedAt !== null);
    const capacity = params.STATION_CAPACITY[s] ?? 4;
    // когда освободится первый слот: минимальное оставшееся время среди блюд в работе
    const remaining = inProgress.map((r) => Math.max(0, Math.round((r.startedAt!.getTime() + r.cookTimeSec * 1000 - now.getTime()) / 1000)));
    const queuedSec = inProgress.length >= capacity ? Math.min(...remaining) : 0;
    load[s] = { inProgress: inProgress.length, capacity, queuedSec: Number.isFinite(queuedSec) ? queuedSec : 0 };
  }
  return load;
}

/** Оценка готовности заказа по текущей загрузке станций — для обещания до оформления (без записи). */
export async function estimateReady(tx: Tx, storeId: string, items: { productId: string; qty: number }[], now: Date): Promise<Date> {
  const dishes = await getDishes(tx, items.map((i) => i.productId));
  const toCook = items.flatMap((i, idx) => {
    const d = dishes.get(i.productId);
    return d ? [{ orderItemId: String(idx), station: d.station, cookTimeSec: d.cookTimeSec * Math.max(1, Math.ceil(i.qty / 2)) }] : [];
  });
  if (toCook.length === 0) return now;
  return scheduleOrder(now, toCook, await stationLoad(tx, storeId, now)).targetReadyAt;
}

/**
 * Заказ SOR оплачен: разложить блюда по станциям и посчитать обещание клиенту.
 * Вызывается из orders в той же транзакции, что и переход в paid_hold.
 */
export async function enqueueOrder(tx: Tx, deps: AppDeps, o: { id: string; storeId: string }, items: { id: string; productId: string; qtyOrdered: number }[], travelMs: number) {
  const now = deps.clock.now();
  const dishes = await getDishes(tx, items.map((i) => i.productId));
  const toCook = items
    .map((i) => {
      const d = dishes.get(i.productId);
      return d ? { orderItemId: i.id, station: d.station, cookTimeSec: d.cookTimeSec * Math.max(1, Math.ceil(i.qtyOrdered / 2)) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (toCook.length === 0) return null;
  const plan = scheduleOrder(now, toCook, await stationLoad(tx, o.storeId, now));
  await tx.insert(kdsItem).values(
    plan.dishes.map((d) => ({
      orderId: o.id,
      orderItemId: d.orderItemId,
      storeId: o.storeId,
      station: d.station,
      cookTimeSec: d.cookTimeSec,
      startAt: d.startAt,
      targetReadyAt: d.targetReadyAt,
    })),
  );
  const promisedAt = sorPromise(plan.targetReadyAt, (await loadParams(tx, o.storeId)).SOR_PREASSIGN_MS, travelMs);
  await setPromisedAt(tx, o.id, promisedAt);
  return { targetReadyAt: plan.targetReadyAt, promisedAt };
}

async function itemViews(tx: Tx, now: Date, where: ReturnType<typeof and>) {
  const rows = await tx
    .select({ k: kdsItem, number: order.number, name: orderItem.nameSnapshot, qty: orderItem.qtyOrdered, modifiers: orderItem.modifiers })
    .from(kdsItem)
    .innerJoin(order, eq(order.id, kdsItem.orderId))
    .innerJoin(orderItem, eq(orderItem.id, kdsItem.orderItemId))
    .where(where)
    .orderBy(asc(kdsItem.startAt));
  return rows.map(({ k, number, name, qty, modifiers }) => ({
    id: k.id,
    order_id: k.orderId,
    order_number: number,
    name,
    qty,
    modifiers,
    station: k.station,
    cook_time_sec: k.cookTimeSec,
    start_at: k.startAt.toISOString(),
    target_ready_at: k.targetReadyAt.toISOString(),
    started_at: k.startedAt?.toISOString() ?? null,
    done_at: k.doneAt?.toISOString() ?? null,
    color: dishColor(now, k, k.doneAt),
  }));
}

/** Очередь станции: не упакованные блюда по времени старта; done остаются до упаковки заказа. */
export async function queue(deps: AppDeps, me: StaffPrincipal, station: Station) {
  const storeId = storeOf(me);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const active = tx.select({ id: order.id }).from(order).where(and(eq(order.storeId, storeId), inArray(order.status, ['paid_hold', 'cooking'])));
    const items = await itemViews(tx, now, and(eq(kdsItem.storeId, storeId), eq(kdsItem.station, station), inArray(kdsItem.orderId, active)));
    return { station, now: now.toISOString(), items };
  });
}

export async function start(deps: AppDeps, me: StaffPrincipal, itemId: string) {
  const storeId = storeOf(me);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [k] = await tx.select().from(kdsItem).where(and(eq(kdsItem.id, itemId), eq(kdsItem.storeId, storeId))).for('update');
    if (!k) throw notFound('Блюдо', itemId);
    if (k.startedAt) throw new AppError('INVALID_TRANSITION', 'Блюдо уже в работе');
    await tx.update(kdsItem).set({ startedAt: now }).where(eq(kdsItem.id, k.id));
    const [o] = await tx.select().from(order).where(eq(order.id, k.orderId)).for('update');
    if (o?.status === 'paid_hold') await transition(tx, o.id, 'paid_hold', 'cooking', 'staff', me.staff_id);
    const [v] = await itemViews(tx, now, eq(kdsItem.id, k.id));
    return v!;
  });
}

export async function done(deps: AppDeps, me: StaffPrincipal, itemId: string) {
  const storeId = storeOf(me);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [k] = await tx.select().from(kdsItem).where(and(eq(kdsItem.id, itemId), eq(kdsItem.storeId, storeId))).for('update');
    if (!k) throw notFound('Блюдо', itemId);
    if (!k.startedAt) throw new AppError('INVALID_TRANSITION', 'Блюдо ещё не начато');
    if (k.doneAt) throw new AppError('INVALID_TRANSITION', 'Блюдо уже готово');
    await tx.update(kdsItem).set({ doneAt: now }).where(eq(kdsItem.id, k.id));
    if (now > k.targetReadyAt)
      await publish(tx, { topic: 'kds.item_late', aggregateType: 'kds_item', aggregateId: k.id, payload: { order_id: k.orderId, late_sec: Math.round((now.getTime() - k.targetReadyAt.getTime()) / 1000) } });
    const [v] = await itemViews(tx, now, eq(kdsItem.id, k.id));
    return v!;
  });
}

/** Станция pack: заказы в готовке целиком. */
export async function packList(deps: AppDeps, me: StaffPrincipal) {
  const storeId = storeOf(me);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const orders = await tx
      .select()
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.brand, 'SOR'), inArray(order.status, ['paid_hold', 'cooking'])))
      .orderBy(asc(order.promisedAt));
    const out = [];
    for (const o of orders) {
      const items = await itemViews(tx, now, eq(kdsItem.orderId, o.id));
      out.push({
        order_id: o.id,
        order_number: o.number,
        target_ready_at: items[0]?.target_ready_at ?? null,
        items,
        all_done: items.length > 0 && items.every((i) => i.done_at !== null),
      });
    }
    return { orders: out };
  });
}

/** Заказ упакован → ready; списание ингредиентов по рецептуре (ТЗ §8). */
export async function packed(deps: AppDeps, me: StaffPrincipal, orderId: string) {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(and(eq(order.id, orderId), eq(order.storeId, storeId))).for('update');
    if (!o) throw notFound('Заказ', orderId);
    const items = await tx.select().from(kdsItem).where(eq(kdsItem.orderId, orderId));
    const notDone = items.filter((i) => !i.doneAt);
    if (items.length === 0) throw new AppError('INVALID_TRANSITION', 'В заказе нет блюд кухни');
    if (notDone.length) throw new AppError('INVALID_TRANSITION', 'Не все блюда готовы', { item_ids: notDone.map((i) => i.id) });
    const oi = await tx.select().from(orderItem).where(eq(orderItem.orderId, orderId));
    const dishes = await getDishes(tx, oi.map((i) => i.productId));
    const consumption = oi.flatMap((i) => (dishes.get(i.productId)?.recipe ?? []).map((r) => ({ productId: r.product_id, grams: r.grams * i.qtyOrdered })));
    await consumeIngredients(tx, storeId, orderId, consumption, me.staff_id);
    await markAllItemsPicked(tx, orderId);
    // кухня могла принять заказ сразу в pack без start (например, только холодные блюда отмечены done) — статус cooking обязателен перед ready
    if (o.status === 'paid_hold') await transition(tx, o.id, 'paid_hold', 'cooking', 'staff', me.staff_id);
    await transition(tx, o.id, 'cooking', 'ready', 'staff', me.staff_id);
    return { order_number: o.number, barcode: `PKG-${o.number}` };
  });
}

/**
 * Отмена SOR после начала готовки (ТЗ §11): начатые блюда идут в списание — расход ингредиентов по рецептуре
 * с причиной. Если заказ уже упакован (ready), расход записан при упаковке, повторно не списываем.
 */
export async function writeOffStartedDishes(tx: Tx, storeId: string, orderId: string, orderStatus: string, actorId: string, reason: string) {
  if (orderStatus !== 'cooking') return 0;
  const started = await tx
    .select({ k: kdsItem, productId: orderItem.productId, qty: orderItem.qtyOrdered })
    .from(kdsItem)
    .innerJoin(orderItem, eq(orderItem.id, kdsItem.orderItemId))
    .where(and(eq(kdsItem.orderId, orderId), sql`${kdsItem.startedAt} is not null`));
  if (started.length === 0) return 0;
  const dishes = await getDishes(tx, started.map((s) => s.productId));
  const lines = started.flatMap((s) => (dishes.get(s.productId)?.recipe ?? []).map((r) => ({ productId: r.product_id, grams: r.grams * s.qty })));
  await consumeIngredients(tx, storeId, orderId, lines, actorId, `отмена после начала готовки: ${reason}`);
  return started.length;
}

export async function getStopList(deps: AppDeps, me: StaffPrincipal) {
  const rows = await deps.db.select().from(stopList).where(and(eq(stopList.storeId, storeOf(me)), isNull(stopList.clearedAt)));
  return {
    product_ids: rows.map((r) => r.productId).filter((x): x is string => !!x),
    ingredient_ids: rows.map((r) => r.ingredientId).filter((x): x is string => !!x),
  };
}

/** Полная замена стоп-листа точки. Витрина перестаёт показывать блюда при следующем запросе каталога (≤ 10 с на клиенте). */
export async function setStopList(deps: AppDeps, me: StaffPrincipal, input: { product_ids: string[]; ingredient_ids: string[] }) {
  const storeId = storeOf(me);
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await tx.update(stopList).set({ clearedAt: now }).where(and(eq(stopList.storeId, storeId), isNull(stopList.clearedAt)));
    const rows = [
      ...input.product_ids.map((id) => ({ storeId, productId: id, ingredientId: null, setBy: me.staff_id })),
      ...input.ingredient_ids.map((id) => ({ storeId, productId: null, ingredientId: id, setBy: me.staff_id })),
    ];
    if (rows.length) await tx.insert(stopList).values(rows);
  });
  return getStopList(deps, me);
}
