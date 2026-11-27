import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const roles = ['manager', 'shift_lead', 'admin', 'finance', 'picker'] as const;
  for (const [i, role] of roles.entries()) {
    const storeId = role === 'admin' || role === 'finance' ? null : w.store.id;
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: `+99290000010${i}`, name: role, role, storeId, pinHash: hashPin('1234') }).returning();
    ids[role] = u!.id;
    tok[role] = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: storeId })).token;
  }
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('каталог и цены', () => {
  it('новая цена закрывает старую, корзина видит новую, изменение в журнале', async () => {
    const r = await call('PUT', `/api/v1/admin/products/${w.p1.id}/price`, tok.manager!, { store_id: w.store.id, price_dirams: 1400, old_price_dirams: 1250, reason: 'новый поставщик' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().prices).toEqual([expect.objectContaining({ store_id: w.store.id, price_dirams: 1400, old_price_dirams: 1250 })]);
    const all = await ctx.deps.db.select().from(s.price).where(eq(s.price.productId, w.p1.id));
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.validTo === null)).toHaveLength(1);
    const cart = await call('PUT', '/api/v1/cart', w.token, { brand: 'LAB', store_id: w.store.id, items: [{ product_id: w.p1.id, qty: 1 }] });
    expect(cart.json().items_total_dirams).toBe(1400);
    const log = await ctx.deps.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'price.set'), eq(s.auditLog.objectId, w.p1.id)));
    expect(log[0]).toMatchObject({ reason: 'новый поставщик', before: { price_dirams: 1250, old_price_dirams: null } });
  });

  it('управляющий не меняет цену чужой точки; сборщик не видит каталог', async () => {
    const other = randomUUID();
    expect((await call('PUT', `/api/v1/admin/products/${w.p1.id}/price`, tok.manager!, { store_id: other, price_dirams: 1, reason: 'x' })).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/products', tok.picker!)).statusCode).toBe(403);
  });

  it('товар: создание, уникальный штрихкод, поиск по штрихкоду, правка', async () => {
    const r = await call('POST', '/api/v1/admin/products', tok.manager!, { brand: 'LAB', sku: 'C-1', name_ru: 'Сок яблочный', barcodes: ['4601'], temp_zone: 'chill' });
    expect(r.statusCode, r.body).toBe(201);
    const dup = await call('POST', '/api/v1/admin/products', tok.manager!, { brand: 'LAB', sku: 'C-2', name_ru: 'Другой', barcodes: ['4601'] });
    expect(dup.json().error.code).toBe('VALIDATION');
    const found = (await call('GET', '/api/v1/admin/products?q=4601', tok.manager!)).json();
    expect(found.products.map((p: any) => p.sku)).toEqual(['C-1']);
    const p = await call('PATCH', `/api/v1/admin/products/${r.json().id}`, tok.manager!, { name_ru: 'Сок яблочный 1 л', is_active: false });
    expect(p.json()).toMatchObject({ name_ru: 'Сок яблочный 1 л', is_active: false });
  });

  it('блюдо только у товара Sor Box', async () => {
    const r = await call('PUT', `/api/v1/admin/products/${w.p1.id}/dish`, tok.manager!, { station: 'pizza', cook_time_sec: 600, modifiers: {}, recipe: [] });
    expect(r.json().error.code).toBe('VALIDATION');
  });

  it('зона: правка тарифа с причиной, видна в resolve', async () => {
    const zones = (await call('GET', `/api/v1/admin/stores/${w.store.id}/zones`, tok.manager!)).json().zones;
    const z = await call('PATCH', `/api/v1/admin/stores/${w.store.id}/zones/${zones[0].id}`, tok.manager!, { fee_dirams: 500, reason: 'акция' });
    expect(z.statusCode, z.body).toBe(200);
    const res = (await call('GET', `/api/v1/stores/resolve?lat=38.55&lon=68.8&brand=LAB`, w.token)).json();
    expect(res.fee_dirams).toBe(500);
  });

  it('точки создаёт только админ', async () => {
    const body = { code: 'T-2', name: 'Вторая', address: 'x', geo: { lat: 38.5, lon: 68.7 }, brands: ['LAB'], work_hours: { mon: { open: '08:00', close: '22:00' } } };
    expect((await call('POST', '/api/v1/admin/stores', tok.manager!, body)).statusCode).toBe(403);
    const ok = await call('POST', '/api/v1/admin/stores', tok.admin!, body);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await call('GET', '/api/v1/admin/stores', tok.admin!)).json().stores).toHaveLength(2);
    expect((await call('GET', '/api/v1/admin/stores', tok.manager!)).json().stores).toHaveLength(1);
  });
});

describe('промо', () => {
  it('создание, применение в корзине, бюджет не ниже потраченного', async () => {
    const r = await call('POST', '/api/v1/admin/promos', tok.manager!, { code: 'MINUS10', type: 'percent', value: 10, audience: 'all', per_customer_limit: 5, budget_dirams: 100000 });
    expect(r.statusCode, r.body).toBe(201);
    const bad = await call('POST', '/api/v1/admin/promos', tok.manager!, { code: 'BAD', type: 'percent', value: 150 });
    expect(bad.json().error.code).toBe('VALIDATION');
    const cart = (await call('PUT', '/api/v1/cart', w.token, { brand: 'LAB', store_id: w.store.id, items: [{ product_id: w.p1.id, qty: 2 }], promo_code: 'MINUS10' })).json();
    expect(cart).toMatchObject({ promo_applied: 'MINUS10', discount_dirams: 280 });
    await ctx.deps.db.update(s.promo).set({ spentDirams: 5000 }).where(eq(s.promo.code, 'MINUS10'));
    const low = await call('PATCH', `/api/v1/admin/promos/${r.json().id}`, tok.manager!, { budget_dirams: 1000, reason: 'урезали' });
    expect(low.json().error.code).toBe('VALIDATION');
    const list = (await call('GET', '/api/v1/admin/promos', tok.manager!)).json();
    expect(list.promos[0]).toMatchObject({ code: 'MINUS10', spent_dirams: 5000, uses: 0 });
    // счётчик использований — коррелированный подзапрос (регрессия неквалифицированной колонки)
    const [o] = await ctx.deps.db.insert(s.order).values({ number: 'L-P1', brand: 'LAB', storeId: w.store.id, customerId: w.cust.id, addressSnapshot: {}, itemsTotalDirams: 0, deliveryFeeDirams: 0, totalDirams: 0 }).returning();
    await ctx.deps.db.insert(s.promoUse).values({ promoId: r.json().id, customerId: w.cust.id, orderId: o!.id, amountDirams: 100 });
    expect((await call('GET', '/api/v1/admin/promos', tok.manager!)).json().promos[0].uses).toBe(1);
  });
});

describe('персонал и роли', () => {
  it('управляющий заводит курьера своей точки (создаётся курьер), но не админа', async () => {
    const r = await call('POST', '/api/v1/admin/staff', tok.manager!, { phone: '+992911111111', name: 'Новый курьер', role: 'courier', store_id: w.store.id, pin: '4321' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).not.toHaveProperty('pin');
    const [c] = await ctx.deps.db.select().from(s.courier).where(eq(s.courier.staffId, r.json().id));
    expect(c).toMatchObject({ transport: 'bike', currentStoreId: w.store.id });
    const admin = await call('POST', '/api/v1/admin/staff', tok.manager!, { phone: '+992911111112', name: 'x', role: 'admin', store_id: null, pin: '1234' });
    expect(admin.statusCode).toBe(403);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/staff', payload: { phone: '+992911111111', pin: '4321' } });
    expect(login.statusCode).toBe(200);
  });

  it('блокировка: доступ теряется сразу; нельзя заблокировать себя', async () => {
    const me = await call('PATCH', `/api/v1/admin/staff/${ids.manager}`, tok.manager!, { is_active: false, reason: 'x' });
    expect(me.statusCode).toBe(403);
    const r = await call('PATCH', `/api/v1/admin/staff/${ids.picker}`, tok.manager!, { is_active: false, reason: 'уволен' });
    expect(r.statusCode, r.body).toBe(200);
    const after = await call('GET', '/api/v1/wms/pick-tasks/next', tok.picker!);
    expect(after.statusCode).toBe(401);
    const log = await ctx.deps.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'staff.update'), eq(s.auditLog.objectId, ids.picker!)));
    expect(log[0]!.reason).toBe('уволен');
  });
});

describe('склад в админке', () => {
  it('ячейки, документ поставки → приёмка, остатки, корректировка только управляющим', async () => {
    const c = await call('POST', `/api/v1/admin/stores/${w.store.id}/cells`, tok.manager!, { code: 'B-01-1', pick_seq: 5, temp_zone: 'chill' });
    expect(c.statusCode, c.body).toBe(201);
    expect((await call('POST', `/api/v1/admin/stores/${w.store.id}/cells`, tok.manager!, { code: 'B-01-1', pick_seq: 6 })).json().error.code).toBe('VALIDATION');
    const cells = (await call('GET', `/api/v1/admin/stores/${w.store.id}/cells`, tok.shift_lead!)).json().cells;
    expect(cells.find((x: any) => x.code === 'A-01-1').used_units).toBe(11);

    const sup = await call('POST', `/api/v1/admin/stores/${w.store.id}/supplies`, tok.shift_lead!, { supplier: 'ООО Молоко', items: [{ product_id: w.p2.id, qty_expected: 10 }] });
    expect(sup.statusCode, sup.body).toBe(201);
    const list = (await call('GET', `/api/v1/admin/stores/${w.store.id}/supplies`, tok.shift_lead!)).json();
    expect(list.supplies[0]).toMatchObject({ supplier: 'ООО Молоко', lines: 1, status: 'expected' });

    const stock = (await call('GET', `/api/v1/admin/stores/${w.store.id}/stock`, tok.shift_lead!)).json().rows;
    expect(stock.find((r: any) => r.product_id === w.p1.id)).toMatchObject({ qty: 10, reserved_qty: 0, unplaced_qty: 0 });

    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect((await call('POST', `/api/v1/admin/stores/${w.store.id}/adjust`, tok.shift_lead!, { lot_id: lot!.id, qty_fact: 8, reason: 'пересчёт' })).statusCode).toBe(403);
    const adj = await call('POST', `/api/v1/admin/stores/${w.store.id}/adjust`, tok.manager!, { lot_id: lot!.id, qty_fact: 8, reason: 'пересчёт' });
    expect(adj.statusCode, adj.body).toBe(200);
    expect(adj.json().qty).toBe(8);
    const moves = await ctx.deps.db.select().from(s.stockMove).where(and(eq(s.stockMove.lotId, lot!.id), eq(s.stockMove.type, 'adjust')));
    expect(moves[0]!.qty).toBe(-2);
  });
});

describe('график курьеров и отчёты', () => {
  it('прогноз по истории тех же дней недели, сохранение плана', async () => {
    // 4 заказа LAB в 12:00 Душанбе ровно неделю назад
    for (let i = 0; i < 4; i++) {
      await ctx.deps.db.insert(s.order).values({
        number: `L-H${i}`, brand: 'LAB', storeId: w.store.id, customerId: w.cust.id, addressSnapshot: {}, status: 'delivered',
        itemsTotalDirams: 1000, deliveryFeeDirams: 0, discountDirams: 0, totalDirams: 1000, capturedDirams: 1000,
        createdAt: new Date('2026-11-20T07:10:00Z'), promisedAt: new Date('2026-11-20T07:25:00Z'), deliveredAt: new Date('2026-11-20T07:20:00Z'),
      });
    }
    const r = (await call('GET', `/api/v1/admin/stores/${w.store.id}/courier-plan?date=2026-11-27`, tok.shift_lead!)).json();
    expect(r.rows[12]).toMatchObject({ forecast_orders_lab: 1, couriers_needed: 1, couriers_planned: 0 });
    const put = await call('PUT', `/api/v1/admin/stores/${w.store.id}/courier-plan?date=2026-11-27`, tok.shift_lead!, { rows: [{ hour: 12, couriers_planned: 2 }] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().rows[12].couriers_planned).toBe(2);
  });

  it('сводка: заказы, выручка, вовремя, средний чек; «Деньги» только финансисту и управляющему', async () => {
    const r = await call('GET', `/api/v1/admin/reports/summary?store_id=${w.store.id}&from=2026-11-20&to=2026-11-20`, tok.manager!);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ orders_total: 4, orders_by_status: { delivered: 4 } });
    expect(r.json().by_brand[0]).toMatchObject({ brand: 'LAB', delivered: 4, captured_dirams: 4000, avg_check_dirams: 1000, on_time_pct: 100 });
    expect(r.json().daily).toEqual([{ date: '2026-11-20', orders: 4, captured_dirams: 4000 }]);
    expect((await call('GET', `/api/v1/admin/reports/money/${w.store.id}`, tok.shift_lead!)).statusCode).toBe(403);
    const m = await call('GET', `/api/v1/admin/reports/money/${w.store.id}`, tok.finance!);
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json()).toHaveProperty('payments_by_status');
  });
});

