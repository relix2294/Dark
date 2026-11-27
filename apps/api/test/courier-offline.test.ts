import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { dispatchStore } from '../src/modules/dispatch/index.js';
import { eventTime } from '../src/modules/dispatch/service.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let courierTok: string;
const T0 = new Date('2026-11-27T07:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  const mk = async (phone: string, role: 'picker' | 'courier') => {
    const [u] = await db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return { id: u!.id, token: (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token };
  };
  picker = (await mk('+992900000061', 'picker')).token;
  const c = await mk('+992900000063', 'courier');
  courierTok = c.token;
  await db.insert(s.courier).values({ staffId: c.id, transport: 'bike' });
});
afterAll(async () => ctx.close());

const call = (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function orderReady() {
  const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 2500 + 1000 });
  expect(r.statusCode, r.body).toBe(201);
  const t = (await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json();
  for (let i = 0; i < 2; i++) await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 1 });
  expect((await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/complete`, picker)).statusCode).toBe(200);
  return r.json() as { id: string; number: string };
}

describe('время события курьера (ТЗ §11)', () => {
  it('eventTime: без at — сейчас; из будущего — сейчас; раньше шага — время шага; старше суток — отказ', () => {
    const now = at(30);
    expect(eventTime(now, undefined)).toEqual(now);
    expect(eventTime(now, at(40).toISOString())).toEqual(now);
    expect(eventTime(now, at(10).toISOString(), at(15))).toEqual(at(15));
    expect(eventTime(now, at(20).toISOString(), at(15))).toEqual(at(20));
    expect(() => eventTime(now, new Date(now.getTime() - 25 * 3600_000).toISOString())).toThrow(/старше суток/);
  });

  it('события из очереди без связи ложатся временем события, а не получения', async () => {
    ctx.setNow(T0);
    expect((await call('POST', '/api/v1/courier/shift/start', courierTok, { transport: 'bike' })).statusCode).toBe(200);
    const o = await orderReady();
    ctx.setNow(at(1));
    expect((await dispatchStore(ctx.deps, w.store.id)).assigned).toBe(1);
    const task = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();

    // курьер забрал пакет в 07:05 и доставил в 07:18, связь появилась только в 07:40
    ctx.setNow(at(40));
    const pk = await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o.number}`], at: at(5).toISOString() });
    expect(pk.statusCode, pk.body).toBe(200);
    const dl = await call('POST', `/api/v1/courier/orders/${o.id}/delivered`, courierTok, { geo: { lat: 38.5501, lon: 68.8001 }, at: at(18).toISOString() });
    expect(dl.statusCode, dl.body).toBe(200);

    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.deliveredAt).toEqual(at(18));
    const [t] = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.id, task.task_id));
    expect(t).toMatchObject({ pickedUpAt: at(5), finishedAt: at(18), status: 'done' });
    const log = await ctx.deps.db.select().from(s.orderStatusLog).where(eq(s.orderStatusLog.orderId, o.id));
    expect(log.find((l) => l.to === 'delivered')!.meta).toMatchObject({ event_at: at(18).toISOString(), received_at: at(40).toISOString() });
    // клиент получил время доставки по факту, а не по связи
    expect((await call('GET', `/api/v1/orders/${o.id}`, w.token)).json().delivered_at).toBe(at(18).toISOString());
  });

  it('событие старше суток — 400 VALIDATION', async () => {
    const o = await orderReady();
    ctx.setNow(at(60));
    await dispatchStore(ctx.deps, w.store.id);
    const task = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();
    const r = await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o.number}`], at: new Date(at(60).getTime() - 25 * 3600_000).toISOString() });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
  });
});
