import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { seedWorld, setupApp } from './helpers.js';
import { OutboxRelay } from '../src/shared/events/outbox.js';
import { registerRealtimeSubscriber } from '../src/modules/realtime/index.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

async function staffToken(storeId: string, active = true) {
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: `+9929${Math.floor(Math.random() * 1e8)}`, name: 'lead', role: 'shift_lead', storeId, pinHash: hashPin('1234'), isActive: active }).returning();
  return (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'shift_lead', store_id: storeId })).token;
}

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
});
afterAll(async () => ctx.close());

const nextMessage = (ws: WebSocket, match: (m: any) => boolean, ms = 3000) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('нет сообщения')), ms);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (match(m)) {
        clearTimeout(t);
        resolve(m);
      }
    });
  });

describe('realtime через NOTIFY (ТЗ §1)', () => {
  it('без токена — закрытие; клиенту нельзя', async () => {
    const ws = await ctx.app.injectWS('/api/v1/ws');
    const code = await new Promise((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
    const cust = await ctx.app.injectWS(`/api/v1/ws?token=${w.token}`);
    expect(await new Promise((r) => cust.on('close', (c) => r(c)))).toBe(4403);
    const blocked = await ctx.app.injectWS(`/api/v1/ws?token=${await staffToken(w.store.id, false)}`);
    expect(await new Promise((r) => blocked.on('close', (c) => r(c)))).toBe(4403);
  });

  it('старший смены получает событие своей точки после заказа и тика outbox', async () => {
    const token = await staffToken(w.store.id);
    const ws = await ctx.app.injectWS(`/api/v1/ws?token=${token}`);
    const hello = await nextMessage(ws, (m) => m.topic === 'hello');
    expect(hello.store_id).toBe(w.store.id);

    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      payload: { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 },
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': randomUUID() },
    });
    expect(r.statusCode, r.body).toBe(201);

    const got = nextMessage(ws, (m) => m.topic === 'order.created');
    const relay = new OutboxRelay(ctx.deps.db);
    registerRealtimeSubscriber(relay, ctx.deps.db);
    expect(await relay.tick()).toBeGreaterThan(0);
    const m = await got;
    expect(m).toMatchObject({ topic: 'order.created', aggregate_type: 'order', aggregate_id: r.json().id, store_id: w.store.id });
    ws.terminate();
  });

  it('событие чужой точки не приходит', async () => {
    const [other] = await ctx.deps.db.insert(s.store).values({ code: 'T-OTHER', name: 'x', lat: 0, lon: 0, address: 'x', brands: ['LAB'], workHours: {} }).returning();
    const token = await staffToken(other!.id);
    const ws = await ctx.app.injectWS(`/api/v1/ws?token=${token}`);
    await nextMessage(ws, (m) => m.topic === 'hello');
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      payload: { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 },
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': randomUUID() },
    });
    expect(r.statusCode).toBe(201);
    const relay = new OutboxRelay(ctx.deps.db);
    registerRealtimeSubscriber(relay, ctx.deps.db);
    await relay.tick();
    await expect(nextMessage(ws, (m) => m.topic === 'order.created', 800)).rejects.toThrow('нет сообщения');
    ws.terminate();
  });
});
