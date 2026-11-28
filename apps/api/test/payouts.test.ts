import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { sendPendingPayouts, shiftPay, StubWalletAdapter } from '../src/modules/payments/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let courierTok: string;
let courierId: string;
let staffId: string;
let manager: string;
let finance: string;
let lead: string;
const T0 = new Date('2026-11-27T07:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  const mk = async (phone: string, role: 'courier' | 'manager' | 'finance' | 'shift_lead', store: string | null = w.store.id) => {
    const [u] = await db.insert(s.userStaff).values({ phone, name: role === 'courier' ? 'Фируз' : role, role, storeId: store, pinHash: hashPin('1234') }).returning();
    return { id: u!.id, token: (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: store })).token };
  };
  const c = await mk('+992900000083', 'courier');
  courierTok = c.token;
  staffId = c.id;
  const [cr] = await db.insert(s.courier).values({ staffId: c.id, transport: 'bike' }).returning();
  courierId = cr!.id;
  manager = (await mk('+992900000085', 'manager')).token;
  finance = (await mk('+992900000086', 'finance', null)).token;
  lead = (await mk('+992900000084', 'shift_lead')).token;
});
afterAll(async () => ctx.close());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('оплата курьеру: только безналично, через DC', () => {
  it('тариф: доставки (и «не вышел») × ставка + км × ставка + часы × ставка', () => {
    expect(shiftPay({ delivered: 7, returned: 1, km: 23.4, minutes: 270 }, { perDelivery: 500, perKm: 100, perHour: 2000 })).toEqual({
      per_delivery_dirams: 500, per_km_dirams: 100, per_hour_dirams: 2000,
      deliveries_dirams: 4000, km_dirams: 2340, hours_dirams: 9000, total_dirams: 15340,
    });
  });

  it('смена закрыта → выплата на DC; без кошелька — no_wallet и тревога; указали кошелёк, повтор — ушло один раз', async () => {
    ctx.setNow(T0);
    await call('POST', '/api/v1/courier/shift/start', courierTok, { transport: 'bike' });
    // одна доставка и трек ~1,1 км
    const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 });
    const oid = r.json().id;
    await ctx.deps.db.insert(s.deliveryTask).values({ courierId, storeId: w.store.id, status: 'done', orderIds: [oid], assignedAt: at(5), pickedUpAt: at(6), finishedAt: at(15) });
    await ctx.deps.db.update(s.order).set({ status: 'delivered', deliveredAt: at(15), promisedAt: at(20) }).where(eq(s.order.id, oid));
    await ctx.deps.db.insert(s.courierPosition).values([
      { courierId, lat: 38.56, lon: 68.78, at: at(6), accuracyM: 5 },
      { courierId, lat: 38.57, lon: 68.78, at: at(12), accuracyM: 5 },
    ]);
    // тариф точки: + 20 сомони в час
    expect((await call('PUT', `/api/v1/backoffice/stores/${w.store.id}/params`, manager, { key: 'COURIER_PAY_PER_HOUR_DIRAMS', value: 2000, reason: 'тариф' })).statusCode).toBe(200);

    ctx.setNow(at(60));
    const live = (await call('GET', '/api/v1/courier/shift/summary', courierTok)).json();
    expect(live.pay).toMatchObject({ deliveries_dirams: 500, km_dirams: 110, hours_dirams: 2000, total_dirams: 2610 });
    expect(live.payout_status).toBeNull();

    expect((await call('POST', '/api/v1/courier/shift/end', courierTok)).statusCode).toBe(200);
    const [p] = await ctx.deps.db.select().from(s.courierPayout).where(eq(s.courierPayout.courierId, courierId));
    expect(p).toMatchObject({ kind: 'shift', amountDirams: 2610, status: 'pending' });

    // кошелька нет — выплата не уходит, финансисту и на пульт — тревога
    expect(await sendPendingPayouts(ctx.deps)).toBe(0);
    const [p1] = await ctx.deps.db.select().from(s.courierPayout).where(eq(s.courierPayout.id, p!.id));
    expect(p1!.status).toBe('no_wallet');
    const alerts = (await call('GET', `/api/v1/console/stores/${w.store.id}/alerts`, lead)).json().alerts;
    expect(alerts.find((a: { topic: string }) => a.topic === 'payout.failed').text).toBe('Выплата курьеру Фируз (26.10 с) не прошла: у курьера не указан кошелёк DC');
    expect((await call('GET', '/api/v1/courier/shift/summary', courierTok)).json().payout_status).toBe('no_wallet');

    // управляющий указывает кошелёк, финансист повторяет — выплата уходит, повторно не платится
    const patch = await call('PATCH', `/api/v1/admin/staff/${staffId}`, manager, { dc_user_id: 'dc-firuz', reason: 'кошелёк для выплат' });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().dc_user_id).toBe('dc-firuz');
    expect((await call('POST', `/api/v1/admin/payouts/${p!.id}/retry`, finance)).statusCode).toBe(200);
    expect(await sendPendingPayouts(ctx.deps)).toBe(1);
    expect(await sendPendingPayouts(ctx.deps)).toBe(0);
    const wallet = ctx.deps.wallet as StubWalletAdapter;
    expect(wallet.payouts).toEqual([{ dcUserId: 'dc-firuz', amount: 2610, reference: `payout:${p!.id}` }]);
    expect((await call('GET', '/api/v1/courier/payouts', courierTok)).json().payouts[0]).toMatchObject({ kind: 'shift', amount_dirams: 2610, status: 'sent' });
    expect((await call('POST', `/api/v1/admin/payouts/${p!.id}/retry`, finance)).json().error.code).toBe('INVALID_TRANSITION');
  });

  it('доплата управляющего — отдельная выплата с причиной и в журнале; старший смены не может; список и итоги', async () => {
    expect((await call('POST', `/api/v1/admin/couriers/${courierId}/bonus`, lead, { amount_dirams: 3000, reason: 'дождь' })).statusCode).toBe(403);
    const b = await call('POST', `/api/v1/admin/couriers/${courierId}/bonus`, manager, { amount_dirams: 3000, reason: 'работа в дождь' });
    expect(b.statusCode, b.body).toBe(201);
    const audit = await ctx.deps.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'payout.bonus'));
    expect(audit[0]).toMatchObject({ reason: 'работа в дождь', after: { amount_dirams: 3000 } });
    await sendPendingPayouts(ctx.deps);
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dushanbe' }); // created_at ставит база
    const list = (await call('GET', `/api/v1/admin/stores/${w.store.id}/payouts?from=${day}&to=${day}`, finance)).json();
    expect(list.totals).toEqual({ sent_dirams: 5610, pending_dirams: 0, problem_dirams: 0 });
    expect(list.payouts.map((x: { kind: string; courier_name: string }) => [x.kind, x.courier_name])).toEqual([['bonus', 'Фируз'], ['shift', 'Фируз']]);
    // чужой кошелёк второму сотруднику не привязать
    const [u2] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000087', name: 'Другой', role: 'courier', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    expect((await call('PATCH', `/api/v1/admin/staff/${u2!.id}`, manager, { dc_user_id: 'dc-firuz', reason: 'x' })).json().error.message).toMatch(/уже привязан/);
  });

  it('банк не ответил — повтор позже тем же ключом; отказал — failed', async () => {
    await ctx.deps.db.update(s.userStaff).set({ dcUserId: 'dc-firuz-timeout' }).where(eq(s.userStaff.id, staffId));
    const b = await call('POST', `/api/v1/admin/couriers/${courierId}/bonus`, manager, { amount_dirams: 1000, reason: 'x' });
    const id = b.json().id;
    expect(await sendPendingPayouts(ctx.deps)).toBe(0);
    const [p] = await ctx.deps.db.select().from(s.courierPayout).where(eq(s.courierPayout.id, id));
    expect(p).toMatchObject({ status: 'pending', attempts: 1 });
    expect(p!.nextAttemptAt!.getTime() - ctx.deps.clock.now().getTime()).toBe(60_000);
    await ctx.deps.db.update(s.userStaff).set({ dcUserId: 'dc-firuz-blocked' }).where(eq(s.userStaff.id, staffId));
    ctx.setNow(new Date(ctx.deps.clock.now().getTime() + 61_000));
    await sendPendingPayouts(ctx.deps);
    const [p2] = await ctx.deps.db.select().from(s.courierPayout).where(eq(s.courierPayout.id, id));
    expect(p2).toMatchObject({ status: 'failed', lastError: 'кошелёк заблокирован' });
  });
});
