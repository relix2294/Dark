import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let tok: string;
let courierId: string;
const T0 = new Date('2026-11-27T07:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000053', name: 'Фируз', role: 'courier', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  tok = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'courier', store_id: w.store.id })).token;
  const [c] = await ctx.deps.db.insert(s.courier).values({ staffId: u!.id, transport: 'bike' }).returning();
  courierId = c!.id;
});
afterAll(async () => ctx.close());

const call = (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('итоги смены курьера (ТЗ §9)', () => {
  it('нет смены → null; смена: время, поездки, доставки, вовремя, возвраты, пробег', async () => {
    ctx.setNow(T0);
    expect((await call('GET', '/api/v1/courier/shift/summary', tok)).json()).toBeNull();
    expect((await call('POST', '/api/v1/courier/shift/start', tok, { transport: 'bike' })).statusCode).toBe(200);

    // три заказа: вовремя, с опозданием, «клиент не вышел» — две поездки (вторая — пакет из двух)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 2500 + 1000 });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().id);
    }
    const db = ctx.deps.db;
    await db.insert(s.deliveryTask).values([
      { courierId, storeId: w.store.id, status: 'done', orderIds: [ids[0]!], assignedAt: at(5), pickedUpAt: at(6), finishedAt: at(16) },
      { courierId, storeId: w.store.id, status: 'done', orderIds: [ids[1]!, ids[2]!], assignedAt: at(30), pickedUpAt: at(31), finishedAt: at(60) },
    ]);
    await db.update(s.order).set({ status: 'delivered', promisedAt: at(20), deliveredAt: at(16) }).where(eq(s.order.id, ids[0]!));
    await db.update(s.order).set({ status: 'delivered', promisedAt: at(40), deliveredAt: at(51) }).where(eq(s.order.id, ids[1]!));
    await db.update(s.order).set({ status: 'returned' }).where(inArray(s.order.id, [ids[2]!]));
    await db.insert(s.courierPosition).values([
      { courierId, lat: 38.56, lon: 68.78, at: at(6), accuracyM: 8 },
      { courierId, lat: 38.57, lon: 68.78, at: at(12), accuracyM: 8 },
      { courierId, lat: 38.56, lon: 68.78, at: at(18), accuracyM: 8 },
    ]);

    ctx.setNow(at(90));
    let r = (await call('GET', '/api/v1/courier/shift/summary', tok)).json();
    expect(r).toEqual({
      shift_started_at: T0.toISOString(), shift_ended_at: null, minutes: 90,
      trips: 2, delivered: 2, on_time: 1, returned: 1, avg_delivery_min: 15, km: 2.2,
      // тариф по умолчанию: 5 с за доставку (и «не вышел»), 1 с за км, 0 за час
      pay: { per_delivery_dirams: 500, per_km_dirams: 100, per_hour_dirams: 0, deliveries_dirams: 1500, km_dirams: 220, hours_dirams: 0, total_dirams: 1720 },
      payout_status: null,
    });

    // смена закрыта — итоги остаются, время не растёт
    expect((await call('POST', '/api/v1/courier/shift/end', tok)).statusCode).toBe(200);
    ctx.setNow(at(200));
    r = (await call('GET', '/api/v1/courier/shift/summary', tok)).json();
    expect(r).toMatchObject({ shift_ended_at: at(90).toISOString(), minutes: 90, delivered: 2, payout_status: 'pending' });
  });
});
