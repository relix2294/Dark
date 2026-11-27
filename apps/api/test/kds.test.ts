import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let cook: string;
let pizza: typeof s.product.$inferSelect;
let salad: typeof s.product.$inferSelect;
let cheese: typeof s.product.$inferSelect;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  await db.update(s.store).set({ brands: ['LAB', 'SOR'] }).where(eq(s.store.id, w.store.id));
  await db.insert(s.deliveryZone).values({ storeId: w.store.id, brand: 'SOR', polygon: [[68.7, 38.5], [68.9, 38.5], [68.9, 38.6], [68.7, 38.6]], feeDirams: 1500, minOrderDirams: 3000, etaMin: 35, etaMax: 55 });
  [pizza, salad, cheese] = (await db
    .insert(s.product)
    .values([
      { brand: 'SOR', sku: 'PZ', nameRu: 'Пицца Маргарита' },
      { brand: 'SOR', sku: 'SL', nameRu: 'Салат Цезарь' },
      { brand: 'SOR', sku: 'CH', nameRu: 'Сыр моцарелла (ингредиент)', unit: 'г', isActive: false },
    ])
    .returning()) as [typeof pizza, typeof salad, typeof cheese];
  await db.insert(s.price).values([
    { productId: pizza.id, storeId: w.store.id, priceDirams: 6500, validFrom: new Date('2026-01-01') },
    { productId: salad.id, storeId: w.store.id, priceDirams: 3900, validFrom: new Date('2026-01-01') },
  ]);
  await db.insert(s.dish).values([
    {
      productId: pizza.id,
      station: 'pizza',
      cookTimeSec: 900,
      recipe: [{ product_id: cheese.id, grams: 120 }],
      modifiers: {
        groups: [
          { id: 'size', name: 'Размер', min: 1, max: 1, options: [{ id: '25', name: '25 см', price_dirams: 0 }, { id: '30', name: '30 см', price_dirams: 1500 }] },
          { id: 'add', name: 'Добавки', min: 0, max: 2, options: [{ id: 'cheese', name: 'Сыр', price_dirams: 500 }, { id: 'mush', name: 'Грибы', price_dirams: 400 }] },
        ],
      },
    },
    { productId: salad.id, station: 'cold', cookTimeSec: 240 },
  ]);
  await db.insert(s.stockLot).values({ storeId: w.store.id, productId: cheese.id, qty: 1000 });
  const [u] = await db.insert(s.userStaff).values({ phone: '+992900000012', name: 'Повар', role: 'cook', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  cook = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'cook', store_id: w.store.id })).token;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('кухня (ТЗ §8)', () => {
  it('стоп-лист по ингредиенту убирает блюдо из витрины', async () => {
    const before = (await call('GET', `/api/v1/catalog?store_id=${w.store.id}&brand=SOR`, w.token)).json();
    expect(before.items.find((i: any) => i.product_id === pizza.id).in_stock).toBe(true);
    const r = await call('PUT', '/api/v1/kds/stop-list', cook, { ingredient_ids: [cheese.id] });
    expect(r.statusCode, r.body).toBe(200);
    const after = (await call('GET', `/api/v1/catalog?store_id=${w.store.id}&brand=SOR`, w.token)).json();
    expect(after.items.find((i: any) => i.product_id === pizza.id).in_stock).toBe(false);
    expect(after.items.find((i: any) => i.product_id === salad.id).in_stock).toBe(true);
    await call('PUT', '/api/v1/kds/stop-list', cook, {});
    expect((await call('GET', '/api/v1/kds/stop-list', cook)).json()).toEqual({ product_ids: [], ingredient_ids: [] });
  });

  it('модификаторы: обязательный размер, доплата считается сервером, каталог отдаёт группы', async () => {
    const cat = (await call('GET', `/api/v1/catalog?store_id=${w.store.id}&brand=SOR`, w.token)).json();
    expect(cat.items.find((i: any) => i.product_id === pizza.id).modifiers.groups.map((g: any) => g.id)).toEqual(['size', 'add']);
    expect(cat.items.find((i: any) => i.product_id === salad.id).modifiers).toBeNull();
    const noSize = await call('PUT', '/api/v1/cart', w.token, { brand: 'SOR', store_id: w.store.id, items: [{ product_id: pizza.id, qty: 1 }] });
    expect(noSize.statusCode).toBe(400);
    expect(noSize.json().error.message).toContain('Размер');
    const ok = (await call('PUT', '/api/v1/cart', w.token, { brand: 'SOR', store_id: w.store.id, items: [{ product_id: pizza.id, qty: 2, modifiers: { size: ['30'], add: ['cheese'] } }] })).json();
    expect(ok.lines[0]).toMatchObject({ price_dirams: 8500, line_total_dirams: 17000, modifiers: [{ group: 'Размер' }, { group: 'Добавки' }] });
  });

  it('заказ → раскладка: салат стартует позже пиццы; старт → cooking; упаковка → ready и расход сыра', async () => {
    const r = await call('POST', '/api/v1/orders', w.token, {
      brand: 'SOR',
      store_id: w.store.id,
      address_id: w.addr.id,
      items: [{ product_id: pizza.id, qty: 1, modifiers: { size: ['30'] } }, { product_id: salad.id, qty: 1 }],
      expected_total_dirams: 6500 + 1500 + 3900 + 1500,
    });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json();
    expect(o.status).toBe('paid_hold');
    expect(o.promised_at).not.toBeNull();

    const items = await ctx.deps.db.select().from(s.kdsItem).where(eq(s.kdsItem.orderId, o.id));
    expect(items).toHaveLength(2);
    const pz = items.find((i) => i.station === 'pizza')!;
    const sl = items.find((i) => i.station === 'cold')!;
    expect(pz.targetReadyAt.getTime()).toBe(sl.targetReadyAt.getTime());
    expect(sl.startAt.getTime() - pz.startAt.getTime()).toBe((900 - 240) * 1000);

    const q = (await call('GET', '/api/v1/kds/queue?station=pizza', cook)).json();
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ order_number: o.number, name: 'Пицца Маргарита', color: 'yellow', modifiers: [{ group: 'Размер', options: [{ name: '30 см', price_dirams: 1500 }] }] });
    expect(o.items.find((i: any) => i.product_id === pizza.id)).toMatchObject({ price_dirams: 8000 });
    const qc = (await call('GET', '/api/v1/kds/queue?station=cold', cook)).json();
    expect(qc.items[0].color).toBe('grey'); // до времени старта

    // упаковать раньше готовности нельзя
    const early = await call('POST', `/api/v1/kds/orders/${o.id}/packed`, cook);
    expect(early.json().error.code).toBe('INVALID_TRANSITION');

    const st = await call('POST', `/api/v1/kds/items/${pz.id}/start`, cook);
    expect(st.statusCode, st.body).toBe(200);
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.status).toBe('cooking');
    expect((await call('POST', `/api/v1/kds/items/${pz.id}/done`, cook)).json().color).toBe('done');
    await call('POST', `/api/v1/kds/items/${sl.id}/start`, cook);
    await call('POST', `/api/v1/kds/items/${sl.id}/done`, cook);

    const pack = (await call('GET', '/api/v1/kds/pack', cook)).json();
    expect(pack.orders[0]).toMatchObject({ order_number: o.number, all_done: true });

    const packed = await call('POST', `/api/v1/kds/orders/${o.id}/packed`, cook);
    expect(packed.statusCode, packed.body).toBe(200);
    expect(packed.json().barcode).toBe(`PKG-${o.number}`);
    const [ord2] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord2!.status).toBe('ready');
    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, cheese.id));
    expect(lot!.qty).toBe(880);
    const moves = await ctx.deps.db.select().from(s.stockMove).where(and(eq(s.stockMove.refId, o.id), eq(s.stockMove.reason, 'recipe')));
    expect(moves).toHaveLength(1);
    // очередь после упаковки пуста
    expect((await call('GET', '/api/v1/kds/queue?station=pizza', cook)).json().items).toHaveLength(0);
  });
});
