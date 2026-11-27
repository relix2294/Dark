import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let lead: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000021', name: 'Сборщик', role: 'picker', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  const [l] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000024', name: 'Старший', role: 'shift_lead', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  picker = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'picker', store_id: w.store.id })).token;
  lead = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: l!.id, role: 'shift_lead', store_id: w.store.id })).token;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

const events = (topic: string, productId: string) =>
  ctx.deps.db.select().from(s.outbox).where(and(eq(s.outbox.topic, topic), eq(s.outbox.aggregateId, productId)));

describe('остатки и лента тревог (ТЗ §9–10)', () => {
  it('резерв опускает доступное ниже порога → stock.low / stock.out, не чаще раза в час', async () => {
    // вафли: 10 → доступно 4 (< 5 шт); молоко: 1 → 0
    const r = await call('POST', '/api/v1/orders', w.token, {
      brand: 'LAB', store_id: w.store.id, address_id: w.addr.id,
      items: [{ product_id: w.p1.id, qty: 6 }, { product_id: w.p2.id, qty: 1 }], expected_total_dirams: 6 * 1250 + 1100 + 1000,
    });
    expect(r.statusCode, r.body).toBe(201);
    const low = await events('stock.low', w.p1.id);
    expect(low).toHaveLength(1);
    expect(low[0]!.payload).toMatchObject({ store_id: w.store.id, available: 4, unit: 'шт', threshold: 5 });
    expect(await events('stock.out', w.p2.id)).toHaveLength(1);
    expect(await events('stock.low', w.p2.id)).toHaveLength(0);

    // ещё один заказ вафель — повторного stock.low в течение часа нет
    const r2 = await call('POST', '/api/v1/orders', w.token, {
      brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 2500 + 1000,
    });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(await events('stock.low', w.p1.id)).toHaveLength(1);
  });

  it('запрос сборщика на списание — своё событие, не stock.low', async () => {
    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    const r = await call('POST', '/api/v1/wms/write-off', picker, { lot_id: lot!.id, qty: 1, reason: 'мятая упаковка' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('requested');
    const req = await ctx.deps.db.select().from(s.outbox).where(eq(s.outbox.topic, 'stock.write_off_requested'));
    expect(req).toHaveLength(1);
    expect(req[0]!.payload).toMatchObject({ store_id: w.store.id, qty: 1, reason: 'мятая упаковка' });
  });

  it('пульт: тревоги точки с текстом и уровнем; точка старых событий — через заказ', async () => {
    const [o] = await ctx.deps.db.select().from(s.order).where(eq(s.order.storeId, w.store.id)).limit(1);
    // событие без store_id в payload (как payment.failed) — точку находим по заказу
    await ctx.deps.db.insert(s.outbox).values({ topic: 'payment.failed', aggregateType: 'payment', aggregateId: randomUUID(), payload: { order_id: o!.id, reason: 'declined' } });
    // чужая точка не попадает
    await ctx.deps.db.insert(s.outbox).values({ topic: 'stock.out', aggregateType: 'product', aggregateId: w.p1.id, payload: { store_id: randomUUID(), name: 'Чужое' } });

    expect((await call('GET', `/api/v1/console/stores/${w.store.id}/alerts`, picker)).statusCode).toBe(403);
    const r = await call('GET', `/api/v1/console/stores/${w.store.id}/alerts`, lead);
    expect(r.statusCode, r.body).toBe(200);
    const alerts: { topic: string; level: string; text: string; order_number: string | null }[] = r.json().alerts;
    expect(alerts.map((a) => a.text)).not.toContain('Закончилось: Чужое');
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'stock.out', level: 'critical', text: 'Закончилось: Молоко' }),
      expect.objectContaining({ topic: 'stock.low', level: 'warning', text: 'Мало: Вафли — осталось 4 шт' }),
      expect.objectContaining({ topic: 'stock.write_off_requested', level: 'info' }),
      expect.objectContaining({ topic: 'payment.failed', level: 'critical', text: `Заказ ${o!.number}: оплата не прошла (declined)`, order_number: o!.number }),
    ]));
    // новые сверху
    expect(alerts[0]!.topic).toBe('payment.failed');
  });
});
