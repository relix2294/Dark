import { and, eq, sql } from 'drizzle-orm';
import type { Brand, CartResponse, CreateOrderRequest, CustomerPrincipal, OrderStatus, OrderView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { address, order, orderItem, orderStatusLog } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { holdAmount } from '../../shared/money.js';
import { loadParams } from '../../shared/params/load.js';
import { getStore, isOpenAt, priceProducts, resolveZone } from '../catalog/index.js';
import { applyPromo, countUses, findPromo, recordUse } from '../promo/index.js';
import { reserveForOrder, unreserve } from '../wms/index.js';
import { enqueueOrder, estimateReady } from '../kds/index.js';
import { applyHoldResult, captureAmountNow, openHold, releaseHold } from '../payments/index.js';
import { courierForOrder, detachOrder } from '../dispatch/index.js';
import type { StaffPrincipal } from '@dark/contracts';
import { percentOf } from '../../shared/money.js';
import { travelMinutes } from '../../shared/geo.js';
import { priceCart } from './pricing.js';
import { CUSTOMER_CANCELLABLE, orderMachine } from './state-machine.js';

/**
 * Сервис заказов — сценарий «корзина → заказ → холд → резерв» (ТЗ §4, §5, §7, §11).
 * Деньги и остатки меняются только внутри транзакции.
 */

type CartCtx = { brand: Brand; store_id: string; address_id?: string | undefined; items: { product_id: string; qty: number }[]; promo_code?: string | undefined };

export async function quoteCart(deps: AppDeps, me: CustomerPrincipal, input: CartCtx): Promise<CartResponse> {
  return deps.db.transaction((tx) => quoteInTx(tx, deps, me, input)).then((q) => q.cart);
}

async function quoteInTx(tx: Tx, deps: AppDeps, me: CustomerPrincipal, input: CartCtx) {
  const store = await getStore(deps, input.store_id);
  let fee = 0;
  let addr: typeof address.$inferSelect | undefined;
  if (input.address_id) {
    [addr] = await tx.select().from(address).where(and(eq(address.id, input.address_id), eq(address.customerId, me.customer_id)));
    if (!addr) throw notFound('Адрес', input.address_id);
    const { zone, store: zoneStore } = await resolveZone(deps, input.brand, addr);
    if (zoneStore.id !== store.id) throw new AppError('OUT_OF_ZONE', 'Адрес обслуживает другая точка', { store_id: zoneStore.id });
    fee = zone.feeDirams;
  }
  const products = await priceProducts(deps, store.id, input.items.map((i) => i.product_id));
  const draft = priceCart(input.items, products, fee, 0, { applied: null, error: null });

  let discount = 0;
  let promoState: { applied: string | null; error: string | null } = { applied: null, error: null };
  let promoRule = null;
  if (input.promo_code) {
    promoRule = await findPromo(tx, input.promo_code);
    if (!promoRule) promoState = { applied: null, error: 'Промокод не найден' };
    else {
      const uses = await countUses(tx, promoRule.id, me.customer_id);
      const res = applyPromo(promoRule, {
        brand: input.brand,
        itemsTotal: draft.items_total_dirams,
        deliveryFee: fee,
        now: deps.clock.now(),
        customerIsNew: await isNewCustomer(tx, me.customer_id),
        customerUses: uses,
        addressNewcomerUses: addr ? await newcomersAtAddress(tx, addr, me.customer_id) : 0,
      });
      if ('error' in res) promoState = { applied: null, error: res.error };
      else {
        discount = res.discount;
        promoState = { applied: promoRule.code, error: null };
      }
    }
  }
  const priced = priceCart(input.items, products, fee, discount, promoState);
  // обещание до оформления (ТЗ §8): LAB — норматив; SOR — раскладка по текущей загрузке кухни + ожидание курьера + путь
  const params = await loadParams(tx, store.id);
  const now = deps.clock.now();
  let etaMs: number = params.LAB_PROMISE_MS;
  if (input.brand === 'SOR') {
    const travelMs = addr ? travelMinutes(store, addr, 'bike') * 60_000 : 15 * 60_000;
    const ready = await estimateReady(tx, store.id, input.items.map((i) => ({ productId: i.product_id, qty: i.qty })), now);
    etaMs = Math.max(params.SOR_PROMISE_MS, ready.getTime() - now.getTime() + params.SOR_PREASSIGN_MS + travelMs);
  }
  const cart = {
    ...priced,
    eta_minutes: Math.ceil(etaMs / 60_000),
    eta_warning: input.brand === 'SOR' && etaMs > params.SOR_MAX_PROMISE_MS,
    accepts_orders: acceptsOrders(store.workHours, now, deps.config.DISPLAY_TZ, params.LAST_ORDER_BEFORE_CLOSE_MS[input.brand] ?? 0),
  };
  return { cart, products, store, promoRule: promoState.applied ? promoRule : null, discount, etaMs };
}

/** Новичок — нет заказов, кроме отменённых и неоплаченных (счётчик orders_count растёт только при доставке). */
async function isNewCustomer(tx: Tx, customerId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(order)
    .where(and(eq(order.customerId, customerId), sql`${order.status} not in ('cancelled', 'payment_failed')`));
  return (r?.n ?? 0) === 0;
}

/**
 * Сколько других клиентов уже получали промо для новичков на этот адрес (ТЗ §11: не больше 2).
 * Адрес совпадает по улице + дому + квартире без учёта регистра и пробелов или по точке ближе ~30 м.
 */
async function newcomersAtAddress(tx: Tx, a: typeof address.$inferSelect, customerId: string) {
  const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, '');
  const d = 0.0003; // ~30 м по широте
  const rows = await tx.execute<{ n: number }>(sql`
    select count(distinct u.customer_id)::int n
    from promo_use u join promo p on p.id = u.promo_id join "order" o on o.id = u.order_id
    where p.audience = 'new' and u.customer_id <> ${customerId}
      and (
        (lower(regexp_replace(coalesce(o.address_snapshot->>'street', ''), '[[:space:]]', '', 'g')) = ${norm(a.street)}
          and lower(regexp_replace(coalesce(o.address_snapshot->>'house', ''), '[[:space:]]', '', 'g')) = ${norm(a.house)}
          and lower(regexp_replace(coalesce(o.address_snapshot->>'flat', ''), '[[:space:]]', '', 'g')) = ${norm(a.flat)})
        or (abs((o.address_snapshot->>'lat')::float - ${a.lat}) < ${d} and abs((o.address_snapshot->>'lon')::float - ${a.lon}) < ${d})
      )`);
  return rows.rows[0]?.n ?? 0;
}

/** Приём заказов: точка открыта сейчас и будет открыта ещё lead мс (ТЗ §11 LAST_ORDER_BEFORE_CLOSE). */
function acceptsOrders(hours: Parameters<typeof isOpenAt>[0], now: Date, tz: string, leadMs: number) {
  return isOpenAt(hours, now, tz) && isOpenAt(hours, new Date(now.getTime() + leadMs), tz);
}

export async function createOrder(deps: AppDeps, me: CustomerPrincipal, input: CreateOrderRequest): Promise<OrderView> {
  const params = await loadParams(deps.db, input.store_id);
  const now = deps.clock.now();

  // Шаг 1: в одной транзакции — проверка корзины, order(created), payment(hold_pending), payment_op
  const created = await deps.db.transaction(async (tx) => {
    const q = await quoteInTx(tx, deps, me, input);
    if (!isOpenAt(q.store.workHours, now, deps.config.DISPLAY_TZ)) throw new AppError('STORE_CLOSED', 'Точка закрыта');
    if (!q.cart.accepts_orders) throw new AppError('STORE_CLOSED', 'Точка скоро закрывается — заказы больше не принимаются', { reason: 'last_order_before_close' });
    if (q.cart.unavailable_product_ids.length) {
      throw new AppError('OUT_OF_STOCK', 'Часть товаров недоступна', { product_ids: q.cart.unavailable_product_ids });
    }
    if (q.cart.total_dirams !== input.expected_total_dirams) {
      throw new AppError('PRICE_CHANGED', 'Сумма изменилась, подтвердите новую корзину', { cart: q.cart });
    }
    const [zoneRow] = await tx.select().from(address).where(eq(address.id, input.address_id));
    const { zone } = await resolveZone(deps, input.brand, zoneRow!);
    if (q.cart.items_total_dirams < zone.minOrderDirams) {
      throw new AppError('MIN_ORDER', 'Сумма меньше минимальной', { min_order_dirams: zone.minOrderDirams });
    }

    const number = await nextOrderNumber(tx, input.brand);
    const promise = q.etaMs;
    const [o] = await tx
      .insert(order)
      .values({
        number,
        brand: input.brand,
        storeId: q.store.id,
        customerId: me.customer_id,
        addressSnapshot: zoneRow as Record<string, unknown>,
        status: 'created',
        itemsTotalDirams: q.cart.items_total_dirams,
        deliveryFeeDirams: q.cart.delivery_fee_dirams,
        discountDirams: q.cart.discount_dirams,
        totalDirams: q.cart.total_dirams,
        promisedAt: new Date(now.getTime() + promise),
        comment: input.comment,
      })
      .returning();
    const items = await tx
      .insert(orderItem)
      .values(
        input.items.map((i, idx) => {
          const p = q.products.get(i.product_id)!;
          const line = q.cart.lines[idx]!;
          return {
            orderId: o!.id,
            productId: i.product_id,
            nameSnapshot: p.nameRu,
            qtyOrdered: i.qty,
            priceDirams: line.price_dirams,
            replacePolicy: i.replace_policy,
            modifiers: line.modifiers.length ? line.modifiers : null,
          };
        }),
      )
      .returning();
    await tx.insert(orderStatusLog).values({ orderId: o!.id, from: null, to: 'created', actorType: 'customer', actorId: me.customer_id });
    if (q.promoRule) await recordUse(tx, q.promoRule, me.customer_id, o!.id, q.discount);
    // Резерв с блокировкой строк партий ДО холда: второй покупатель последней единицы получает OUT_OF_STOCK,
    // деньги не трогаются (ТЗ §11). При отказе банка резерв снимается в tx2.
    if (input.brand === 'LAB')
      await reserveForOrder(tx, q.store.id, o!.id, items.map((i) => ({ orderItemId: i.id, productId: i.productId, qty: i.qtyOrdered })), now, params.MIN_SHELF_LIFE_PCT);

    const hasWeighted = input.items.some((i) => q.products.get(i.product_id)?.isWeighted);
    const hold = holdAmount(q.cart.total_dirams, input.brand === 'LAB' && hasWeighted, params.HOLD_BUFFER_PCT);
    const { paymentId, key: idemKey } = await openHold(tx, o!.id, hold);
    await publish(tx, { topic: 'order.created', aggregateType: 'order', aggregateId: o!.id, payload: { number, brand: input.brand, store_id: q.store.id } });
    return { o: o!, items, paymentId, idemKey, hold, products: q.products, store: q.store, addr: zoneRow! };
  });

  // Шаг 2: вызов банка вне транзакции БД (таймаут PAYMENT_HOLD_TIMEOUT_MS)
  const res = await withTimeout(
    deps.wallet.hold({ dcUserId: me.dc_user_id, amount: created.hold, orderNumber: created.o.number, idempotencyKey: created.idemKey }),
    params.PAYMENT_HOLD_TIMEOUT_MS,
  );

  // Шаг 3: результат — в транзакции: held + paid_hold + резерв, либо failed
  await deps.db.transaction(async (tx) => {
    await applyHoldResult(tx, created.paymentId, created.idemKey, res);
    if (res.ok) {
      await transition(tx, created.o.id, 'created', 'paid_hold', 'system', null);
      if (created.o.brand === 'SOR') {
        const travelMs = travelMinutes(created.store, created.addr, 'bike') * 60_000;
        await enqueueOrder(tx, deps, created.o, created.items, travelMs);
      }
    } else if (res.reason !== 'timeout') {
      // заказ остаётся created при таймауте: сверка опросит status() (ТЗ §5 п.4)
      await unreserve(tx, created.items.map((i) => i.id));
      await transition(tx, created.o.id, 'created', 'payment_failed', 'system', null, { reason: res.reason });
    }
  });

  if (!res.ok && res.reason !== 'timeout') {
    throw new AppError('PAYMENT_DECLINED', 'Оплата отклонена', { order_id: created.o.id, reason: res.reason });
  }
  return getOrderView(deps, created.o.id, me);
}

export async function transition(
  tx: Tx,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actorType: 'customer' | 'staff' | 'system',
  actorId: string | null,
  meta?: Record<string, unknown>,
) {
  orderMachine.assert(from, to, actorType);
  const updated = await tx
    .update(order)
    .set({ status: to, updatedAt: new Date(), ...(to === 'ready' ? { readyAt: new Date() } : {}), ...(to === 'delivered' ? { deliveredAt: new Date() } : {}) })
    .where(and(eq(order.id, orderId), eq(order.status, from)))
    .returning({ id: order.id });
  if (updated.length === 0) throw new AppError('INVALID_TRANSITION', `Заказ уже не в статусе ${from}`, { from, to });
  await tx.insert(orderStatusLog).values({ orderId, from, to, actorType, actorId, meta: meta ?? null });
  await publish(tx, { topic: 'order.status_changed', aggregateType: 'order', aggregateId: orderId, payload: { from, to, actor_type: actorType } });
}

export async function cancelByCustomer(deps: AppDeps, me: CustomerPrincipal, orderId: string, reason?: string): Promise<OrderView> {
  await deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(and(eq(order.id, orderId), eq(order.customerId, me.customer_id))).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (!CUSTOMER_CANCELLABLE.has(o.status)) {
      orderMachine.assert(o.status, 'cancelled', 'customer');
      throw new AppError('FORBIDDEN', 'Отмена после начала сборки — только оператор', { status: o.status });
    }
    const items = await tx.select({ id: orderItem.id }).from(orderItem).where(eq(orderItem.orderId, o.id));
    await unreserve(tx, items.map((i) => i.id));
    await releaseHold(tx, deps, o.id);
    await tx.update(order).set({ cancelReason: reason ?? 'клиент' }).where(eq(order.id, o.id));
    await detachOrder(tx, o.id, 'заказ отменён клиентом');
    await transition(tx, o.id, o.status, 'cancelled', 'customer', me.customer_id, { reason });
  });
  return getOrderView(deps, orderId, me);
}

export async function getOrderView(deps: AppDeps, orderId: string, me: CustomerPrincipal): Promise<OrderView> {
  const [o] = await deps.db.select().from(order).where(and(eq(order.id, orderId), eq(order.customerId, me.customer_id)));
  if (!o) throw notFound('Заказ', orderId);
  const items = await deps.db.select().from(orderItem).where(eq(orderItem.orderId, o.id));
  const c = await deps.db.transaction((tx) => courierForOrder(tx, o.id));
  const courierView = c && ['on_the_way', 'ready'].includes(o.status) ? { name: c.name, position: c.position } : null;
  return {
    id: o.id,
    number: o.number,
    brand: o.brand,
    store_id: o.storeId,
    status: o.status,
    items: items.map((i) => ({
      id: i.id,
      product_id: i.productId,
      name_snapshot: i.nameSnapshot,
      qty_ordered: i.qtyOrdered,
      qty_picked: i.qtyPicked,
      price_dirams: i.priceDirams,
      status: i.status,
      replaced_by_item_id: i.replacedByItemId,
      modifiers: i.modifiers ?? null,
    })),
    items_total_dirams: o.itemsTotalDirams,
    delivery_fee_dirams: o.deliveryFeeDirams,
    discount_dirams: o.discountDirams,
    total_dirams: o.totalDirams,
    captured_dirams: o.capturedDirams,
    promised_at: o.promisedAt?.toISOString() ?? null,
    ready_at: o.readyAt?.toISOString() ?? null,
    delivered_at: o.deliveredAt?.toISOString() ?? null,
    courier: courierView,
    created_at: o.createdAt.toISOString(),
  };
}

/** Номер заказа: L-000123 / S-000123, последовательность в БД на бренд. */
async function nextOrderNumber(tx: Tx, brand: Brand): Promise<string> {
  const seq = brand === 'LAB' ? 'order_number_lab' : 'order_number_sor';
  const [r] = await tx.execute<{ n: string }>(sql`select nextval(${seq}) as n`).then((x) => x.rows);
  return `${brand === 'LAB' ? 'L' : 'S'}-${String(r!.n).padStart(6, '0')}`;
}

async function withTimeout<T extends { ok: boolean }>(p: Promise<T>, ms: number): Promise<T | { ok: false; reason: 'timeout'; message: string }> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; reason: 'timeout'; message: string }>((resolve) => {
    t = setTimeout(() => resolve({ ok: false, reason: 'timeout', message: `нет ответа банка за ${ms} мс` }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Отмена оператором с причиной (ТЗ §3, §11): из paid_hold / picking / cooking / ready.
 * LAB: резерв снят, холд снят. SOR после начала готовки: списывается SOR_CANCEL_FEE_PCT от блюд, блюда в списание.
 */
export async function cancelByStaff(deps: AppDeps, me: StaffPrincipal, orderId: string, reason: string) {
  const r = await deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (me.store_id && me.store_id !== o.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
    orderMachine.assert(o.status, 'cancelled', 'staff');
    const items = await tx.select({ id: orderItem.id }).from(orderItem).where(eq(orderItem.orderId, o.id));
    await unreserve(tx, items.map((i) => i.id));
    let fee = 0;
    if (o.brand === 'SOR' && ['cooking', 'ready'].includes(o.status)) fee = percentOf(o.itemsTotalDirams, (await loadParams(tx, o.storeId)).SOR_CANCEL_FEE_PCT);
    await tx.update(order).set({ cancelReason: reason, capturedDirams: fee }).where(eq(order.id, o.id));
    await detachOrder(tx, o.id, `заказ отменён: ${reason}`);
    await transition(tx, o.id, o.status, 'cancelled', 'staff', me.staff_id, { reason, fee_dirams: fee });
    if (fee === 0) await releaseHold(tx, deps, o.id);
    return { fee };
  });
  if (r.fee > 0) await captureAmountNow(deps, orderId, r.fee);
  return { order_id: orderId, captured_dirams: r.fee };
}

/** Сверка признала холд несостоявшимся: заказ created → payment_failed, резерв снят. */
export async function markPaymentFailed(deps: AppDeps, orderIds: string[]) {
  for (const id of orderIds) {
    await deps.db.transaction(async (tx) => {
      const [o] = await tx.select().from(order).where(eq(order.id, id)).for('update');
      if (!o || o.status !== 'created') return;
      const items = await tx.select({ id: orderItem.id }).from(orderItem).where(eq(orderItem.orderId, id));
      await unreserve(tx, items.map((i) => i.id));
      await transition(tx, id, 'created', 'payment_failed', 'system', null, { reason: 'timeout' });
    });
  }
}

/** Заказы точки для пульта старшего смены. */
export async function consoleOrders(deps: AppDeps, storeId: string) {
  const now = deps.clock.now();
  const rows = await deps.db
    .select()
    .from(order)
    .where(and(eq(order.storeId, storeId), sql`${order.status} in ('created','paid_hold','picking','cooking','ready','on_the_way','returning')`))
    .orderBy(order.createdAt);
  const out = [];
  for (const o of rows) {
    const c = await deps.db.transaction((tx) => courierForOrder(tx, o.id));
    const a = o.addressSnapshot as Record<string, unknown>;
    out.push({
      id: o.id,
      number: o.number,
      brand: o.brand,
      status: o.status,
      total_dirams: o.totalDirams,
      created_at: o.createdAt.toISOString(),
      promised_at: o.promisedAt?.toISOString() ?? null,
      ready_at: o.readyAt?.toISOString() ?? null,
      courier: c ? { courier_id: c.courier_id, name: c.name, task_status: c.task_status } : null,
      waiting_min: o.status === 'ready' && !c && o.readyAt ? Math.round((now.getTime() - o.readyAt.getTime()) / 60_000) : null,
      address_short: `${String(a['street'] ?? '')} ${String(a['house'] ?? '')}`.trim(),
      geo: typeof a['lat'] === 'number' && typeof a['lon'] === 'number' ? { lat: a['lat'], lon: a['lon'] } : null,
    });
  }
  return { orders: out };
}

/** История заказов клиента (последние 50) и повтор заказа — на клиенте по составу. */
export async function listOrders(deps: AppDeps, me: CustomerPrincipal) {
  const rows = await deps.db.select({ id: order.id }).from(order).where(eq(order.customerId, me.customer_id)).orderBy(sql`${order.createdAt} desc`).limit(50);
  const orders = [];
  for (const r of rows) orders.push(await getOrderView(deps, r.id, me));
  return { orders };
}
