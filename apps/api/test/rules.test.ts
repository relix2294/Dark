import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

/** Правила ТЗ §8, §11, §12, которые легко потерять: параметры точки, отсечка, обещание, новички, геозона. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let manager: string;
let lead: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const mk = async (phone: string, role: 'manager' | 'shift_lead') => {
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token;
  };
  manager = await mk('+992900000301', 'manager');
  lead = await mk('+992900000302', 'shift_lead');
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function customer(dc: string, street = 'Рудаки', house = '1', flat?: string) {
  const [c] = await ctx.deps.db.insert(s.customer).values({ dcUserId: dc }).returning();
  const [a] = await ctx.deps.db.insert(s.address).values({ customerId: c!.id, lat: 38.55, lon: 68.8, street, house, flat: flat ?? null }).returning();
  const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: c!.id, dc_user_id: dc });
  return { id: c!.id, addr: a!.id, token };
}
const labOrder = (token: string, addr: string, total: number, promo?: string) =>
  call('POST', '/api/v1/orders', token, { brand: 'LAB', store_id: w.store.id, address_id: addr, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: total, ...(promo ? { promo_code: promo } : {}) });

describe('параметры точки действуют (ТЗ §12)', () => {
  it('изменённое обещание LAB видно в корзине и в заказе', async () => {
    const put = await call('PUT', `/api/v1/backoffice/stores/${w.store.id}/params`, manager, { key: 'LAB_PROMISE_MS', value: 25 * 60_000, reason: 'пробки' });
    expect(put.statusCode, put.body).toBe(200);
    const bad = await call('PUT', `/api/v1/backoffice/stores/${w.store.id}/params`, manager, { key: 'LAB_PROMISE_MS', value: 'долго', reason: 'x' });
    expect(bad.statusCode).toBe(400);
    const cart = (await call('PUT', '/api/v1/cart', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }] })).json();
    expect(cart).toMatchObject({ eta_minutes: 25, eta_warning: false, accepts_orders: true });
    const o = (await labOrder(w.token, w.addr.id, 3500)).json();
    expect(new Date(o.promised_at).getTime() - ctx.deps.clock.now().getTime()).toBe(25 * 60_000);
    await call('PUT', `/api/v1/backoffice/stores/${w.store.id}/params`, manager, { key: 'LAB_PROMISE_MS', value: 15 * 60_000, reason: 'вернули' });
  });
});

describe('приём заказов перед закрытием (ТЗ §11)', () => {
  it('за 20 минут до закрытия LAB заказы не принимаются', async () => {
    ctx.setNow(new Date('2026-11-27T17:50:00Z')); // 22:50 Душанбе, закрытие в 23:00
    const cart = (await call('PUT', '/api/v1/cart', w.token, { brand: 'LAB', store_id: w.store.id, items: [{ product_id: w.p1.id, qty: 2 }] })).json();
    expect(cart.accepts_orders).toBe(false);
    const r = await labOrder(w.token, w.addr.id, 3500);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'STORE_CLOSED', details: { reason: 'last_order_before_close' } });
    ctx.setNow(new Date('2026-11-27T07:00:00Z'));
  });
});

describe('обещание Sor Box до оформления (ТЗ §8)', () => {
  it('больше SOR_MAX_PROMISE — предупреждение в корзине', async () => {
    await ctx.deps.db.update(s.store).set({ brands: ['LAB', 'SOR'] }).where(eq(s.store.id, w.store.id));
    await ctx.deps.db.insert(s.deliveryZone).values({ storeId: w.store.id, brand: 'SOR', polygon: [[68.7, 38.5], [68.9, 38.5], [68.9, 38.6], [68.7, 38.6]], feeDirams: 1500, minOrderDirams: 1000, etaMin: 35, etaMax: 55 });
    const [pz] = await ctx.deps.db.insert(s.product).values({ brand: 'SOR', sku: 'PZ', nameRu: 'Пицца' }).returning();
    await ctx.deps.db.insert(s.price).values({ productId: pz!.id, storeId: w.store.id, priceDirams: 6000, validFrom: new Date('2026-01-01') });
    await ctx.deps.db.insert(s.dish).values({ productId: pz!.id, station: 'pizza', cookTimeSec: 1200 });
    const cart = async () => (await call('PUT', '/api/v1/cart', w.token, { brand: 'SOR', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: pz!.id, qty: 1 }] })).json();
    expect(await cart()).toMatchObject({ eta_minutes: 45, eta_warning: false });
    // кухня перегружена: печь занята, ждать 40 минут
    await call('PUT', `/api/v1/backoffice/stores/${w.store.id}/params`, manager, { key: 'STATION_CAPACITY', value: { pizza: 1 }, reason: 'одна печь' });
    const [it0] = await ctx.deps.db.insert(s.order).values({ number: 'S-BUSY', brand: 'SOR', storeId: w.store.id, customerId: w.cust.id, addressSnapshot: {}, status: 'cooking', itemsTotalDirams: 0, deliveryFeeDirams: 0, totalDirams: 0 }).returning();
    const [oi] = await ctx.deps.db.insert(s.orderItem).values({ orderId: it0!.id, productId: pz!.id, nameSnapshot: 'Пицца', qtyOrdered: 1, priceDirams: 0 }).returning();
    const now = ctx.deps.clock.now();
    await ctx.deps.db.insert(s.kdsItem).values({ orderId: it0!.id, orderItemId: oi!.id, storeId: w.store.id, station: 'pizza', cookTimeSec: 2400, startAt: now, targetReadyAt: new Date(now.getTime() + 2400_000), startedAt: now });
    const busy = await cart();
    expect(busy.eta_warning).toBe(true);
    expect(busy.eta_minutes).toBeGreaterThan(60);
  });
});

describe('промо новичка (ТЗ §11)', () => {
  it('новичок — до первого заказа; не больше 2 новичков на адрес', async () => {
    await ctx.deps.db.insert(s.promo).values({ code: 'NEW', type: 'free_delivery', value: 0, audience: 'new', perCustomerLimit: 1 });
    const a = await customer('u-a', 'Рудаки', '10', '5');
    const b = await customer('u-b', 'рудаки ', '10', '5');
    const c = await customer('u-c', 'РУДАКИ', '10', '5');
    expect((await labOrder(a.token, a.addr, 2500, 'NEW')).statusCode).toBe(201);
    // после заказа a уже не новичок
    const again = (await call('PUT', '/api/v1/cart', a.token, { brand: 'LAB', store_id: w.store.id, address_id: a.addr, items: [{ product_id: w.p1.id, qty: 2 }], promo_code: 'NEW' })).json();
    expect(again.promo_error).toBe('Только для новых клиентов');
    expect((await labOrder(b.token, b.addr, 2500, 'NEW')).statusCode).toBe(201);
    const third = (await call('PUT', '/api/v1/cart', c.token, { brand: 'LAB', store_id: w.store.id, address_id: c.addr, items: [{ product_id: w.p1.id, qty: 2 }], promo_code: 'NEW' })).json();
    expect(third.promo_error).toBe('Лимит на адрес исчерпан');
  });
});

describe('доставка вне геозоны (ТЗ §11)', () => {
  it('подтверждает старший смены с причиной; клиенту засчитан заказ', async () => {
    const cu = await customer('u-geo', 'Сомони', '3');
    const o = (await labOrder(cu.token, cu.addr, 3500)).json();
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000303', name: 'Курьер', role: 'courier', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    const [cr] = await ctx.deps.db.insert(s.courier).values({ staffId: u!.id, status: 'delivering', currentStoreId: w.store.id }).returning();
    await ctx.deps.db.update(s.order).set({ status: 'on_the_way' }).where(eq(s.order.id, o.id));
    await ctx.deps.db.insert(s.deliveryTask).values({ courierId: cr!.id, storeId: w.store.id, status: 'delivering', orderIds: [o.id] });
    const cTok = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'courier', store_id: w.store.id })).token;
    const far = await call('POST', `/api/v1/courier/orders/${o.id}/delivered`, cTok, { geo: { lat: 38.6, lon: 68.9 } });
    expect(far.json().error.code).toBe('TOO_FAR_FROM_ADDRESS');
    const noReason = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/delivered`, lead, { reason: '' });
    expect(noReason.statusCode).toBe(400);
    const ok = await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/delivered`, lead, { reason: 'клиент встретил у соседнего дома' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ captured: true, task_status: 'done' });
    const [c2] = await ctx.deps.db.select().from(s.courier).where(eq(s.courier.id, cr!.id));
    expect(c2!.status).toBe('returning');
    const [cust] = await ctx.deps.db.select().from(s.customer).where(eq(s.customer.id, cu.id));
    expect(cust).toMatchObject({ ordersCount: 1 });
    expect(cust!.firstOrderAt).not.toBeNull();
    const log = await ctx.deps.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'order.delivered_override'), eq(s.auditLog.objectId, o.id)));
    expect(log[0]!.reason).toBe('клиент встретил у соседнего дома');
  });
});
