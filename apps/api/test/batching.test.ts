import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { dispatchStore } from '../src/modules/dispatch/index.js';

/** Объединение поездок (ТЗ §6, этап 2): один курьер везёт два заказа одной поездкой. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let courierTok: string;
let courierId: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000501', name: 'Курьер', role: 'courier', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  const [c] = await ctx.deps.db.insert(s.courier).values({ staffId: u!.id, status: 'free', currentStoreId: w.store.id }).returning();
  courierId = c!.id;
  courierTok = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'courier', store_id: w.store.id })).token;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function readyOrder(dc: string, lat: number, lon: number) {
  const [cu] = await ctx.deps.db.insert(s.customer).values({ dcUserId: dc }).returning();
  const [a] = await ctx.deps.db.insert(s.address).values({ customerId: cu!.id, lat, lon, street: 'Рудаки', house: dc }).returning();
  const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: cu!.id, dc_user_id: dc });
  const r = await call('POST', '/api/v1/orders', token, { brand: 'LAB', store_id: w.store.id, address_id: a!.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 });
  expect(r.statusCode, r.body).toBe(201);
  await ctx.deps.db.update(s.order).set({ status: 'ready', readyAt: ctx.deps.clock.now() }).where(eq(s.order.id, r.json().id));
  return r.json() as { id: string; number: string };
}

describe('объединение поездок', () => {
  it('два готовых заказа к соседним домам, курьер один — одно задание, доставка по порядку', async () => {
    const o1 = await readyOrder('b1', 38.565, 68.78);
    const o2 = await readyOrder('b2', 38.5655, 68.7805);
    const r = await dispatchStore(ctx.deps, w.store.id);
    expect(r.assigned).toBe(2);
    const tasks = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.courierId, courierId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.orderIds).toEqual([o1.id, o2.id]);
    expect(JSON.parse(tasks[0]!.dispatchSnapshot!)).toMatchObject({ rule: 'batch', sequence: [o1.id, o2.id] });

    const view = (await call('GET', '/api/v1/courier/tasks/current', courierTok)).json();
    expect(view.orders.map((o: any) => o.number)).toEqual([o1.number, o2.number]);
    const pk = await call('POST', `/api/v1/courier/tasks/${view.task_id}/pickup`, courierTok, { package_barcodes: [`PKG-${o1.number}`, `PKG-${o2.number}`] });
    expect(pk.statusCode, pk.body).toBe(200);

    const d1 = await call('POST', `/api/v1/courier/orders/${o1.id}/delivered`, courierTok, { geo: { lat: 38.565, lon: 68.78 } });
    expect(d1.json()).toMatchObject({ task_status: 'delivering' });
    const d2 = await call('POST', `/api/v1/courier/orders/${o2.id}/delivered`, courierTok, { geo: { lat: 38.5655, lon: 68.7805 } });
    expect(d2.json()).toMatchObject({ task_status: 'done', captured: true });
    const [c] = await ctx.deps.db.select().from(s.courier).where(eq(s.courier.id, courierId));
    expect(c!.status).toBe('returning');
  });

  it('новый заказ подсаживается к курьеру, который ещё на точке', async () => {
    await ctx.deps.db.update(s.courier).set({ status: 'free' }).where(eq(s.courier.id, courierId));
    const o1 = await readyOrder('b3', 38.565, 68.78);
    expect((await dispatchStore(ctx.deps, w.store.id)).assigned).toBe(1);
    const o2 = await readyOrder('b4', 38.5652, 68.7802);
    expect((await dispatchStore(ctx.deps, w.store.id)).assigned).toBe(1);
    const [t] = await ctx.deps.db.select().from(s.deliveryTask).where(eq(s.deliveryTask.status, 'accepted'));
    expect(t!.orderIds).toEqual([o1.id, o2.id]);
  });
});
