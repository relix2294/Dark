import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let lead: string;
let orderId: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [l] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000034', name: 'Старший', role: 'shift_lead', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  lead = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: l!.id, role: 'shift_lead', store_id: w.store.id })).token;
  const r = await call('POST', '/api/v1/orders', w.token, {
    brand: 'LAB', store_id: w.store.id, address_id: w.addr.id,
    items: [{ product_id: w.p1.id, qty: 2, replace_policy: 'auto' }, { product_id: w.p2.id, qty: 1, replace_policy: 'remove' }], expected_total_dirams: 2500 + 1100 + 1000,
  });
  expect(r.statusCode, r.body).toBe(201);
  orderId = r.json().id;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('повтор заказа (ТЗ §9)', () => {
  it('исходные позиции без замен сборщика; снятое с продажи — в skipped', async () => {
    // сборщик заменил вафли молоком: замена не попадает в повтор
    const [waf] = await ctx.deps.db.select().from(s.orderItem).where(eq(s.orderItem.productId, w.p1.id));
    const [rep] = await ctx.deps.db.insert(s.orderItem).values({ orderId, productId: w.p2.id, nameSnapshot: 'Молоко', qtyOrdered: 2, qtyPicked: 2, priceDirams: 1100, status: 'picked' }).returning();
    await ctx.deps.db.update(s.orderItem).set({ status: 'replaced', replacedByItemId: rep!.id }).where(eq(s.orderItem.id, waf!.id));

    let r = await call('GET', `/api/v1/orders/${orderId}/repeat`, w.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      brand: 'LAB', store_id: w.store.id, skipped: [],
      items: [{ product_id: w.p1.id, qty: 2, replace_policy: 'auto' }, { product_id: w.p2.id, qty: 1, replace_policy: 'remove' }],
    });

    await ctx.deps.db.update(s.product).set({ isActive: false }).where(eq(s.product.id, w.p2.id));
    r = await call('GET', `/api/v1/orders/${orderId}/repeat`, w.token);
    expect(r.json().items).toEqual([{ product_id: w.p1.id, qty: 2, replace_policy: 'auto' }]);
    expect(r.json().skipped).toEqual([{ product_id: w.p2.id, name: 'Молоко', reason: 'больше не продаётся' }]);
    await ctx.deps.db.update(s.product).set({ isActive: true }).where(eq(s.product.id, w.p2.id));

    // чужой заказ не повторить
    const [other] = await ctx.deps.db.insert(s.customer).values({ dcUserId: 'u-other' }).returning();
    const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: other!.id, dc_user_id: 'u-other' });
    expect((await call('GET', `/api/v1/orders/${orderId}/repeat`, token)).statusCode).toBe(404);
  });
});

describe('оценка после доставки (ТЗ §9)', () => {
  it('только доставленный, один раз; низкая — тревога на пульт; средняя — в отчёте', async () => {
    let r = await call('POST', `/api/v1/orders/${orderId}/rating`, w.token, { score: 5 });
    expect(r.json().error.code).toBe('INVALID_TRANSITION');

    await ctx.deps.db.update(s.order).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(s.order.id, orderId));
    r = await call('POST', `/api/v1/orders/${orderId}/rating`, w.token, { score: 2, tags: ['late', 'late', 'damaged'], comment: '  мятые вафли ' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ score: 2, tags: ['late', 'damaged'], comment: 'мятые вафли' });

    r = await call('POST', `/api/v1/orders/${orderId}/rating`, w.token, { score: 5 });
    expect(r.statusCode).toBe(409);
    expect((await call('POST', `/api/v1/orders/${orderId}/rating`, w.token, { score: 6 })).statusCode).toBe(400);

    const view = (await call('GET', `/api/v1/orders/${orderId}`, w.token)).json();
    expect(view.rating).toMatchObject({ score: 2, tags: ['late', 'damaged'] });

    const alerts = (await call('GET', `/api/v1/console/stores/${w.store.id}/alerts`, lead)).json().alerts;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'order.rated', level: 'critical', text: `Заказ ${view.number}: оценка 2 из 5 (опоздание, повреждено) — «мятые вафли»` }),
    ]));

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dushanbe' });
    const rep = await call('GET', `/api/v1/admin/reports/summary?store_id=${w.store.id}&from=${today}&to=${today}`, lead);
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().rating).toEqual({ count: 1, avg: 2, low: 1 });
  });
});
