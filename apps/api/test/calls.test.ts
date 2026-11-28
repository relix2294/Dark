import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { dispatchStore } from '../src/modules/dispatch/index.js';
import { closeFinishedSessions, StubCallProxy } from '../src/modules/calls/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let courierTok: string;
let otherCourierTok: string;
const T0 = new Date('2026-11-27T07:00:00Z');

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  const mk = async (phone: string, role: 'picker' | 'courier') => {
    const [u] = await db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return { id: u!.id, token: (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token };
  };
  picker = (await mk('+992900000071', 'picker')).token;
  const c = await mk('+992900000073', 'courier');
  courierTok = c.token;
  await db.insert(s.courier).values({ staffId: c.id, transport: 'bike' });
  const c2 = await mk('+992900000074', 'courier');
  otherCourierTok = c2.token;
  await db.insert(s.courier).values({ staffId: c2.id, transport: 'bike' });
});
afterAll(async () => ctx.close());

const call = (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function orderReady() {
  const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 });
  expect(r.statusCode, r.body).toBe(201);
  const t = (await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json();
  for (let i = 0; i < 2; i++) await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 1 });
  await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/complete`, picker);
  return r.json() as { id: string; number: string };
}

describe('звонки через подменный номер (ТЗ §9)', () => {
  it('курьер и клиент получают подменный номер, настоящие номера не раскрываются; связка закрывается после доставки', async () => {
    ctx.setNow(T0);
    await call('POST', '/api/v1/courier/shift/start', courierTok, { transport: 'bike' });
    const o = await orderReady();
    await dispatchStore(ctx.deps, w.store.id);
    const task = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();
    expect(task.orders[0]).toMatchObject({ call_number: null, calls_made: 0, customer_phone_masked: '+992 ** *** 22 33' });

    // клиент до назначения… курьер уже назначен — может звонить
    const pk = await call('POST', `/api/v1/courier/tasks/${task.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o.number}`] });
    expect(pk.statusCode, pk.body).toBe(200);
    // связка создана при заборе — номер есть в задании заранее (для звонка без связи)
    const proxy = pk.json().orders[0].call_number as string;
    expect(proxy).toMatch(/^\+99200\d{7}$/);
    expect(JSON.stringify(pk.json())).not.toContain('+992901112233');

    const c1 = await call('POST', `/api/v1/courier/orders/${o.id}/call`, courierTok, {});
    expect(c1.json()).toEqual({ dial: proxy });
    const cc = await call('POST', `/api/v1/orders/${o.id}/call-courier`, w.token);
    expect(cc.statusCode, cc.body).toBe(200);
    expect(cc.json().dial).toMatch(/^\+99200/);
    expect(JSON.stringify(cc.json())).not.toContain('+992900000073');
    const stub = ctx.deps.calls as StubCallProxy;
    expect([...stub.active.values()]).toEqual([{ courierPhone: '+992900000073', customerPhone: '+992901112233' }]);
    expect((await call('GET', '/api/v1/courier/tasks/current', courierTok)).json().orders[0].calls_made).toBe(1);

    // чужой курьер и чужой клиент не звонят
    expect((await call('POST', `/api/v1/courier/orders/${o.id}/call`, otherCourierTok, {})).statusCode).toBe(404);
    const [other] = await ctx.deps.db.insert(s.customer).values({ dcUserId: 'u-x', phone: '+992905556677' }).returning();
    const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: other!.id, dc_user_id: 'u-x' });
    expect((await call('POST', `/api/v1/orders/${o.id}/call-courier`, token)).statusCode).toBe(404);

    // доставлено → полчаса клиент ещё может перезвонить, потом номер больше не соединяет
    expect((await call('POST', `/api/v1/courier/orders/${o.id}/delivered`, courierTok, { geo: { lat: 38.5501, lon: 68.8001 } })).statusCode).toBe(200);
    expect(await closeFinishedSessions(ctx.deps)).toBe(0);
    ctx.setNow(new Date(T0.getTime() + 31 * 60_000)); // прошло полчаса после доставки
    expect(await closeFinishedSessions(ctx.deps)).toBe(1);
    expect(stub.active.size).toBe(0);
    expect(await ctx.deps.db.select().from(s.callSession).where(and(eq(s.callSession.orderId, o.id), isNull(s.callSession.closedAt)))).toHaveLength(0);
  });

  it('нет номера клиента или провайдер отказал — CALL_UNAVAILABLE (503), без подмены настоящим номером', async () => {
    const o = await orderReady();
    await dispatchStore(ctx.deps, w.store.id);
    await ctx.deps.db.update(s.customer).set({ phone: '+992900000000' }).where(eq(s.customer.id, w.cust.id)); // заглушка отказывает
    const r = await call('POST', `/api/v1/courier/orders/${o.id}/call`, courierTok, {});
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('CALL_UNAVAILABLE');
    await ctx.deps.db.update(s.customer).set({ phone: null }).where(eq(s.customer.id, w.cust.id));
    expect((await call('POST', `/api/v1/courier/orders/${o.id}/call`, courierTok, {})).json().error.code).toBe('CALL_UNAVAILABLE');
    await ctx.deps.db.update(s.customer).set({ phone: '+992901112233' }).where(eq(s.customer.id, w.cust.id));
  });
});
