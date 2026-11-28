import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { dispatchStore } from '../src/modules/dispatch/index.js';
import { reconcilePending } from '../src/modules/payments/index.js';
import { markPaymentFailed } from '../src/modules/orders/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let courierTok: string;
let lead: string;
let courierId: string;
let leadId: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  const mk = async (phone: string, role: 'picker' | 'courier' | 'shift_lead') => {
    const [u] = await db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return { id: u!.id, token: (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token };
  };
  picker = (await mk('+992900000021', 'picker')).token;
  const c = await mk('+992900000023', 'courier');
  courierTok = c.token;
  const l = await mk('+992900000024', 'shift_lead');
  lead = l.token;
  leadId = l.id;
  const [cr] = await db.insert(s.courier).values({ staffId: c.id, transport: 'bike' }).returning();
  courierId = cr!.id;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function orderReady(qty = 1) {
  const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: qty + 1 }], expected_total_dirams: 1250 * (qty + 1) + 1000 });
  expect(r.statusCode, r.body).toBe(201);
  const o = r.json();
  const t = (await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json();
  expect(t.order_id).toBe(o.id);
  for (let i = 0; i < qty + 1; i++) await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 1 });
  const done = await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/complete`, picker);
  expect(done.statusCode, done.body).toBe(200);
  return o as { id: string; number: string };
}

describe('курьер и диспетчер (ТЗ §6, §11)', () => {
  it('смена: offline → free; закрыть с активным заданием нельзя', async () => {
    const me = (await call('GET', '/api/v1/courier/me', courierTok)).json();
    expect(me.status).toBe('offline');
    const st = await call('POST', '/api/v1/courier/shift/start', courierTok, { transport: 'bike' });
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json()).toMatchObject({ status: 'free', store_id: w.store.id });
    const pos = await ctx.app.inject({ method: 'POST', url: '/api/v1/courier/position', payload: { points: [{ lat: 38.56, lon: 68.78, at: '2026-11-27T06:59:00Z', accuracy_m: 5 }] }, headers: { authorization: `Bearer ${courierTok}` } });
    expect(pos.statusCode, pos.body).toBe(200);
  });

  it('полный цикл: заказ → сборка → диспетчер назначает → скан пакета → доставлено → списание', async () => {
    const o = await orderReady();
    expect((await call('GET', '/api/v1/courier/tasks/current', courierTok)).json()).toBeNull();

    const r = await dispatchStore(ctx.deps, w.store.id);
    expect(r.assigned).toBe(1);
    const task = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();
    expect(task).toMatchObject({ status: 'accepted' }); // AUTO_ACCEPT
    expect(task.orders[0]).toMatchObject({ number: o.number, package_barcode: `PKG-${o.number}`, status: 'ready' });
    const [cr] = await ctx.deps.db.select().from(s.courier).where(eq(s.courier.id, courierId));
    expect(cr!.status).toBe('assigned');
    // повторный тик не назначает второй раз
    expect((await dispatchStore(ctx.deps, w.store.id)).assigned).toBe(0);

    const wrong = await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: ['PKG-X'] });
    expect(wrong.json().error.code).toBe('WRONG_PRODUCT');
    const pk = await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o.number}`] });
    expect(pk.statusCode, pk.body).toBe(200);
    expect(pk.json()).toMatchObject({ status: 'delivering' });
    expect(pk.json().orders[0].status).toBe('on_the_way');
    expect((await call('GET', '/api/v1/courier/me', courierTok)).json().status).toBe('delivering');

    // клиент видит курьера
    const view = (await call('GET', `/api/v1/orders/${o.id}`, w.token)).json();
    expect(view.courier).toMatchObject({ name: 'courier' });

    const far = await call('POST', `/api/v1/courier/orders/${o.id}/delivered`, courierTok, { geo: { lat: 38.6, lon: 68.9 } });
    expect(far.json().error.code).toBe('TOO_FAR_FROM_ADDRESS');
    const ok = await call('POST', `/api/v1/courier/orders/${o.id}/delivered`, courierTok, { geo: { lat: 38.5501, lon: 68.8001 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ captured: true, task_status: 'done' });
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.status).toBe('delivered');
    const [pay] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, o.id));
    expect(pay).toMatchObject({ status: 'captured', capturedDirams: 3500 });
    expect((await call('GET', '/api/v1/courier/me', courierTok)).json()).toMatchObject({ status: 'returning', deliveries_today: 1 });

    // вернулся на точку → free
    await ctx.app.inject({ method: 'POST', url: '/api/v1/courier/position', payload: { points: [{ lat: 38.56, lon: 68.78, at: '2026-11-27T06:59:30Z', accuracy_m: 5 }] }, headers: { authorization: `Bearer ${courierTok}` } });
    expect((await call('GET', '/api/v1/courier/me', courierTok)).json().status).toBe('free');
  });

  it('возврат (ТЗ §9): до лимита — старший смены; выше лимита — 403', async () => {
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.status, 'delivered'));
    const big = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${ord!.id}/refund`, lead, { amount_dirams: 30000, reason: 'x' });
    expect(big.statusCode).toBe(403);
    const tooMuch = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${ord!.id}/refund`, lead, { amount_dirams: 3600, reason: 'x' });
    expect(tooMuch.json().error.code).toBe('VALIDATION');
    const ok = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${ord!.id}/refund`, lead, { amount_dirams: 500, reason: 'товар помят' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ payment_status: 'partially_refunded', refunded_dirams: 500 });
    const log = await ctx.deps.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'payment.refund'));
    expect(log).toHaveLength(1);
  });

  it('клиент не вышел: returning → пакет принят на точке, товар на склад, списана только доставка', async () => {
    const o = await orderReady();
    await dispatchStore(ctx.deps, w.store.id);
    const task = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();
    await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o.number}`] });
    // без звонков и без ожидания у двери — нельзя (ТЗ §11)
    let ns = await call('POST', `/api/v1/courier/orders/${o.id}/no-show`, courierTok, { comment: 'не открыл' });
    expect(ns.json().error).toMatchObject({ code: 'INVALID_TRANSITION', details: { calls_made: 0 } });
    const now0 = ctx.deps.clock.now();
    for (let i = 0; i < 2; i++) expect((await call('POST', `/api/v1/courier/orders/${o.id}/call`, courierTok, {})).statusCode).toBe(200);
    ns = await call('POST', `/api/v1/courier/orders/${o.id}/no-show`, courierTok, { comment: 'не открыл' });
    expect(ns.json().error.message).toMatch(/Подождите у двери ещё 5 мин/);
    ctx.setNow(new Date(now0.getTime() + 5 * 60_000));
    ns = await call('POST', `/api/v1/courier/orders/${o.id}/no-show`, courierTok, { comment: 'не открыл' });
    ctx.setNow(now0);
    expect(ns.statusCode, ns.body).toBe(200);
    expect(ns.json().status).toBe('failed');
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.status).toBe('returning');

    const lotsBefore = (await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id))).length;
    const ret = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/returned`, lead, { comment: 'пакет на полке выдачи' });
    expect(ret.statusCode, ret.body).toBe(200);
    expect(ret.json().captured_dirams).toBe(1000);
    const [ord2] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord2!.status).toBe('returned');
    const lotsAfter = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect(lotsAfter.length).toBe(lotsBefore + 1); // новая партия без ячейки
    expect(lotsAfter.some((l) => l.cellId === null && l.qty === 2)).toBe(true);
    const [pay] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, o.id));
    expect(pay).toMatchObject({ status: 'captured', capturedDirams: 1000 });
    // курьер вернулся
    await ctx.app.inject({ method: 'POST', url: '/api/v1/courier/position', payload: { points: [{ lat: 38.56, lon: 68.78, at: '2026-11-27T06:59:40Z', accuracy_m: 5 }] }, headers: { authorization: `Bearer ${courierTok}` } });
  });

  it('пульт: список заказов, ручное назначение с причиной, отмена оператором снимает холд', async () => {
    const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 });
    const o = r.json();
    await call('GET', '/api/v1/wms/pick-tasks/next', picker); // picking
    const list = (await call('GET', `/api/v1/console/stores/${w.store.id}/orders`, lead)).json();
    expect(list.orders.find((x: any) => x.id === o.id)).toMatchObject({ status: 'picking', courier: null });
    const couriers = (await call('GET', `/api/v1/console/stores/${w.store.id}/couriers`, lead)).json();
    expect(couriers.couriers[0]).toMatchObject({ courier_id: courierId, status: 'free' });

    // причина — из списка (ТЗ §6); «другое» без комментария не принимается
    const noReason = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/assign`, lead, { courier_id: courierId, reason: 'срочный клиент' });
    expect(noReason.statusCode).toBe(400);
    const otherBare = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/assign`, lead, { courier_id: courierId, reason_code: 'other' });
    expect(otherBare.statusCode).toBe(400);

    // назначить → снять → заказ снова без курьера, курьер свободен, в журнале — кто и почему
    const first = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/assign`, lead, { courier_id: courierId, reason_code: 'courier_closer' });
    expect(first.statusCode, first.body).toBe(200);
    const un = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/unassign`, lead, { reason_code: 'courier_unreachable', comment: 'не берёт трубку' });
    expect(un.statusCode, un.body).toBe(200);
    const [ft] = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.id, first.json().task_id));
    expect(ft).toMatchObject({ status: 'reassigned', overrideReason: 'курьер не отвечает: не берёт трубку' });
    expect((await call('GET', `/api/v1/console/stores/${w.store.id}/couriers`, lead)).json().couriers[0].status).toBe('free');
    // диспетчер не вернёт заказ тому же курьеру сразу после снятия
    expect((await dispatchStore(ctx.deps, w.store.id)).assigned).toBe(0);
    const unAudit = await ctx.deps.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'dispatch.unassign'), eq(s.auditLog.objectId, o.id)));
    expect(unAudit[0]).toMatchObject({ actorId: leadId, reason: 'курьер не отвечает: не берёт трубку', before: { courier_id: courierId } });
    expect((await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/unassign`, lead, { reason_code: 'other', comment: 'x' })).json().error.code).toBe('INVALID_TRANSITION');
    expect((await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/unassign`, picker, { reason_code: 'urgent_order' })).statusCode).toBe(403);

    const as = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/assign`, lead, { courier_id: courierId, reason_code: 'other', comment: 'срочный клиент' });
    expect(as.statusCode, as.body).toBe(200);
    expect(as.json()).toMatchObject({ status: 'accepted' });
    const [t] = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.id, as.json().task_id));
    expect(t).toMatchObject({ assignedBy: 'manual', overrideReason: 'другое: срочный клиент' });

    // сборщик не может отменить после старта сборки, старший — может
    const pickerCancel = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/cancel`, picker, { reason: 'x' });
    expect(pickerCancel.statusCode).toBe(403);
    const cancel = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/cancel`, lead, { reason: 'клиент попросил' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const [pay] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, o.id));
    expect(pay!.status).toBe('released');
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord).toMatchObject({ status: 'cancelled', cancelReason: 'клиент попросил' });
    const audit = await ctx.deps.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'order.cancel'), eq(s.auditLog.objectId, o.id)));
    expect(audit[0]!.actorId).toBe(leadId);
    // назначенный курьер освобождается, задание закрыто с причиной
    const [t2] = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.id, as.json().task_id));
    expect(t2).toMatchObject({ status: 'reassigned', overrideReason: 'заказ отменён: клиент попросил' });
    const [cr] = await ctx.deps.db.select().from(s.courier).where(eq(s.courier.id, courierId));
    expect(cr!.status).toBe('free');
  });

  it('сверка: холд без ответа банка 60 с → payment_failed, резерв снят', async () => {
    const [c] = await ctx.deps.db.insert(s.customer).values({ dcUserId: 'u-timeout' }).returning();
    const [a] = await ctx.deps.db.insert(s.address).values({ customerId: c!.id, lat: 38.55, lon: 68.8, street: 'x', house: '1' }).returning();
    const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: c!.id, dc_user_id: 'u-timeout' });
    const before = (await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id))).reduce((x, l) => x + l.reservedQty, 0);
    const r = await call('POST', '/api/v1/orders', token, { brand: 'LAB', store_id: w.store.id, address_id: a!.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().status).toBe('created'); // «проверяем оплату»
    const reservedNow = (await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id))).reduce((x, l) => x + l.reservedQty, 0);
    expect(reservedNow).toBe(before + 2);

    // ещё рано
    expect((await reconcilePending(ctx.deps)).failedOrderIds).toEqual([]);
    ctx.setNow(new Date(Date.now() + 120_000));
    const rec = await reconcilePending(ctx.deps);
    expect(rec.failedOrderIds).toEqual([r.json().id]);
    await markPaymentFailed(ctx.deps, rec.failedOrderIds);
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, r.json().id));
    expect(ord!.status).toBe('payment_failed');
    const after = (await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id))).reduce((x, l) => x + l.reservedQty, 0);
    expect(after).toBe(before);
    ctx.setNow(new Date('2026-11-27T07:00:00Z'));
  });
});
