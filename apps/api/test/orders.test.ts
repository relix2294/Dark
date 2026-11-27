import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
});
afterAll(async () => ctx.close());

const post = async (url: string, body: Record<string, unknown>, token: string, key = randomUUID()) =>
  ctx.app.inject({ method: 'POST', url, payload: body, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key } });

describe('POST /orders — сценарий приёмки', () => {
  it('без Idempotency-Key — 400', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', payload: {}, headers: { authorization: `Bearer ${w.token}` } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('корзина пересчитывается; сумма не совпала — 409 PRICE_CHANGED с новой корзиной', async () => {
    const cart = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/cart',
      payload: { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }] },
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': randomUUID() },
    });
    expect(cart.statusCode).toBe(200);
    expect(cart.json()).toMatchObject({ items_total_dirams: 2500, delivery_fee_dirams: 1000, total_dirams: 3500 });

    const r = await post('/api/v1/orders', { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3400 }, w.token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PRICE_CHANGED');
    expect(r.json().error.details.cart.total_dirams).toBe(3500);
  });

  it('успешный заказ: paid_hold, холд, резерв; повтор по ключу возвращает тот же ответ', async () => {
    const key = randomUUID();
    const body = { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 };
    const r1 = await post('/api/v1/orders', body, w.token, key);
    expect(r1.statusCode, r1.body).toBe(201);
    const o = r1.json();
    expect(o.status).toBe('paid_hold');
    expect(o.number).toMatch(/^L-\d{6}$/);

    const r2 = await post('/api/v1/orders', body, w.token, key);
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().id).toBe(o.id);

    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect(lot!.reservedQty).toBe(2);
    const [pay] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, o.id));
    expect(pay).toMatchObject({ status: 'held', holdDirams: 3500 });
    const events = await ctx.deps.db.select().from(s.outbox);
    expect(events.map((e) => e.topic)).toEqual(expect.arrayContaining(['order.created', 'payment.held', 'order.status_changed']));

    // тот же ключ, другое тело — конфликт
    const r3 = await post('/api/v1/orders', { ...body, comment: 'другое' }, w.token, key);
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('последняя единица: второй покупатель получает OUT_OF_STOCK, деньги не трогаются', async () => {
    const body = { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 1 }, { product_id: w.p2.id, qty: 1 }], expected_total_dirams: 3350 };
    const ok = await post('/api/v1/orders', body, w.token);
    expect(ok.statusCode, ok.body).toBe(201);
    const again = await post('/api/v1/orders', body, w.token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('OUT_OF_STOCK');
    expect(again.json().error.details.product_ids).toEqual([w.p2.id]);
  });

  it('отказ банка → payment_failed, резерв не создаётся', async () => {
    const [c] = await ctx.deps.db.insert(s.customer).values({ dcUserId: 'u-declined' }).returning();
    const [a] = await ctx.deps.db.insert(s.address).values({ customerId: c!.id, lat: 38.55, lon: 68.8, street: 'x', house: '1' }).returning();
    const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: c!.id, dc_user_id: 'u-declined' });
    const r = await post('/api/v1/orders', { brand: 'LAB', store_id: w.store.id, address_id: a!.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 }, token);
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe('PAYMENT_DECLINED');
    const [o] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, r.json().error.details.order_id));
    expect(o!.status).toBe('payment_failed');
    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect(lot!.reservedQty).toBe(3); // 2 + 1 из прошлых тестов, без изменений
  });

  it('отмена клиентом до сборки: холд снят, резерв снят; после — только оператор', async () => {
    const r = await post('/api/v1/orders', { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 }, w.token);
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const c = await post(`/api/v1/orders/${id}/cancel`, { reason: 'передумал' }, w.token);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().status).toBe('cancelled');
    const [pay] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, id));
    expect(pay!.status).toBe('released');
    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect(lot!.reservedQty).toBe(3);

    // заказ в picking — клиенту нельзя
    const r2 = await post('/api/v1/orders', { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 }, w.token);
    await ctx.deps.db.update(s.order).set({ status: 'picking' }).where(eq(s.order.id, r2.json().id));
    const c2 = await post(`/api/v1/orders/${r2.json().id}/cancel`, {}, w.token);
    expect(c2.statusCode).toBe(403);
  });

  it('чужой заказ не виден', async () => {
    const other = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: randomUUID(), dc_user_id: 'x' });
    const list = await ctx.deps.db.select().from(s.order).limit(1);
    const r = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${list[0]!.id}`, headers: { authorization: `Bearer ${other.token}` } });
    expect(r.statusCode).toBe(404);
  });
});

describe('auth персонала и права', () => {
  it('вход по PIN, права по роли, чужая точка — 403', async () => {
    const { hashPin } = await import('../src/shared/auth/index.js');
    await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000001', name: 'A', role: 'picker', storeId: w.store.id, pinHash: hashPin('1234') });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/staff', payload: { phone: '+992900000001', pin: '0000' } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/staff', payload: { phone: '+992900000001', pin: '1234' } });
    expect(ok.statusCode).toBe(200);
    const token = ok.json().token;
    const params = await ctx.app.inject({ method: 'GET', url: `/api/v1/backoffice/stores/${w.store.id}/params`, headers: { authorization: `Bearer ${token}` } });
    expect(params.statusCode).toBe(403); // сборщик не видит пульт
  });
});
