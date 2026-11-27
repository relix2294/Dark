import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { OutboxRelay } from '../src/shared/events/outbox.js';
import { StubChannel, detectDelays, registerNotifySubscribers, sendPending, smsFallback } from '../src/modules/notify/index.js';

/** Уведомления клиенту по таблице ТЗ §10. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let relay: OutboxRelay;
let lead: string;
const sent = () => (ctx.deps.channel as StubChannel).sent;
const T0 = new Date('2026-11-27T07:00:00Z');

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  relay = new OutboxRelay(ctx.deps.db);
  registerNotifySubscribers(relay, ctx.deps, ctx.app.log);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000901', name: 'Старший', role: 'shift_lead', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  lead = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'shift_lead', store_id: w.store.id })).token;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });
const flush = async () => {
  while ((await relay.tick()) > 0);
  await sendPending(ctx.deps);
  await smsFallback(ctx.deps);
};

describe('уведомления клиенту', () => {
  it('заказ принят → пуш с номером и временем; повтор события — без дубля', async () => {
    const o = (await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 })).json();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ channel: 'push', dcUserId: 'u-1' });
    expect(sent()[0]!.text).toBe(`Lablabu: заказ ${o.number} принят\nДоставим к 12:15.`);
    // то же событие пришло ещё раз (повторная доставка outbox) — второго уведомления нет
    await ctx.deps.db.update(s.outbox).set({ publishedAt: null });
    await flush();
    expect(sent()).toHaveLength(1);
    const feed = (await call('GET', '/api/v1/notifications', w.token)).json();
    expect(feed).toMatchObject({ unread: 1, notifications: [{ kind: 'accepted', order_id: o.id, read: false }] });
    const read = (await call('POST', '/api/v1/notifications/read', w.token, { ids: [feed.notifications[0].id] })).json();
    expect(read.unread).toBe(0);
  });

  it('курьер выехал: пуш не доставлен → через 30 с SMS; доставлен — SMS нет', async () => {
    const [c] = await ctx.deps.db.insert(s.customer).values({ dcUserId: 'u-x-nopush' }).returning();
    const [a] = await ctx.deps.db.insert(s.address).values({ customerId: c!.id, lat: 38.55, lon: 68.8, street: 'x', house: '1' }).returning();
    const { token } = await ctx.deps.tokens.sign({ kind: 'customer', customer_id: c!.id, dc_user_id: 'u-x-nopush' });
    const o = (await call('POST', '/api/v1/orders', token, { brand: 'LAB', store_id: w.store.id, address_id: a!.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 })).json();
    await flush();
    const before = sent().length;
    // заказ поехал (переход — как его делает курьер при скане пакета)
    await ctx.deps.db.update(s.order).set({ status: 'ready' }).where(eq(s.order.id, o.id));
    const { transition } = await import('../src/modules/orders/index.js');
    await ctx.deps.db.transaction((tx) => transition(tx, o.id, 'ready', 'on_the_way', 'staff', null));
    await flush();
    const pushed = sent().slice(before);
    expect(pushed.map((x) => x.channel)).toEqual(['push']);
    expect(pushed[0]!.text).toContain('выехал');
    expect(pushed[0]!.text).toContain(`/store/?order=${o.id}`);
    ctx.setNow(new Date(T0.getTime() + 31_000));
    await flush();
    const after = sent().slice(before);
    expect(after.map((x) => x.channel)).toEqual(['push', 'sms']);
    await flush();
    expect(sent().slice(before)).toHaveLength(2); // SMS один раз
    ctx.setNow(T0);
  });

  it('задержка больше 5 минут — одно уведомление с новым временем', async () => {
    ctx.setNow(new Date(T0.getTime() + 21 * 60_000)); // обещание первого заказа — 12:15, сейчас 12:21
    expect(await detectDelays(ctx.deps)).toBeGreaterThan(0);
    expect(await detectDelays(ctx.deps)).toBe(0);
    await flush();
    expect(sent().some((x) => x.text.includes('задерживается'))).toBe(true);
    ctx.setNow(T0);
  });

  it('отмена оператором — причина и что с деньгами', async () => {
    const o = (await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 })).json();
    await call('POST', `/api/v1/console/stores/${w.store.id}/orders/${o.id}/cancel`, lead, { reason: 'товар повреждён' });
    await flush();
    const last = sent().at(-1)!;
    expect(last.text).toBe(`Заказ ${o.number} отменён\nПричина: товар повреждён. Деньги не списаны, блокировка на карте снята.`);
  });
});
