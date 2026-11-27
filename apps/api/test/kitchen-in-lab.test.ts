import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

/** Блюдо Sor Box в заказе Lablabu (ТЗ §8, этап 2). */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let cook: string;
let salad: typeof s.product.$inferSelect;
let tomato: typeof s.product.$inferSelect;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const db = ctx.deps.db;
  await db.update(s.store).set({ brands: ['LAB', 'SOR'] }).where(eq(s.store.id, w.store.id));
  [salad] = await db.insert(s.product).values({ brand: 'SOR', sku: 'SL', nameRu: 'Салат Цезарь' }).returning() as [typeof salad];
  [tomato] = await db.insert(s.product).values({ brand: 'SOR', sku: 'TM', nameRu: 'Томаты (ингредиент)', unit: 'г', isActive: false }).returning() as [typeof tomato];
  await db.insert(s.price).values({ productId: salad.id, storeId: w.store.id, priceDirams: 3900, validFrom: new Date('2026-01-01') });
  await db.insert(s.dish).values({ productId: salad.id, station: 'cold', cookTimeSec: 240, recipe: [{ product_id: tomato.id, grams: 80 }] });
  await db.insert(s.stockLot).values({ storeId: w.store.id, productId: tomato.id, qty: 1000 });
  const mk = async (phone: string, role: 'picker' | 'cook') => {
    const [u] = await db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token;
  };
  picker = await mk('+992900000601', 'picker');
  cook = await mk('+992900000602', 'cook');
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('блюдо кухни в заказе Lablabu', () => {
  it('каталог Lablabu показывает блюдо кухни; заказ без резерва блюда; кухня готовит; сборщик забирает', async () => {
    const cat = (await call('GET', `/api/v1/catalog?store_id=${w.store.id}&brand=LAB`, w.token)).json();
    expect(cat.items.find((i: any) => i.product_id === salad.id)).toMatchObject({ from_kitchen: true, in_stock: true });
    expect(cat.items.find((i: any) => i.product_id === w.p1.id)).toMatchObject({ from_kitchen: false });

    const r = await call('POST', '/api/v1/orders', w.token, {
      brand: 'LAB', store_id: w.store.id, address_id: w.addr.id,
      items: [{ product_id: w.p1.id, qty: 2 }, { product_id: salad.id, qty: 1 }],
      expected_total_dirams: 2500 + 3900 + 1000,
    });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json();
    expect(new Date(o.promised_at).getTime() - ctx.deps.clock.now().getTime()).toBe(15 * 60_000); // обещание Lablabu не тронуто

    // в очереди холодного цеха — блюдо заказа L-…
    const q = (await call('GET', '/api/v1/kds/queue?station=cold', cook)).json();
    expect(q.items).toHaveLength(1);
    expect(q.items[0].order_number).toBe(o.number);

    // сборщик: склад — как обычно, салат — «с кухни», пока не готов
    const t = (await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json();
    const saladItem = t.items.find((i: any) => i.product_id === salad.id);
    expect(saladItem).toMatchObject({ kitchen: { ready: false, station: 'cold' }, cells: [] });
    await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 2 });
    expect((await call('POST', `/api/v1/kds/handoff/${saladItem.order_item_id}`, picker)).json().error.code).toBe('INVALID_TRANSITION');
    expect((await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/complete`, picker)).json().error.code).toBe('INVALID_TRANSITION');

    // кухня готовит; заказ LAB остаётся в сборке (не cooking)
    await call('POST', `/api/v1/kds/items/${q.items[0].id}/start`, cook);
    await call('POST', `/api/v1/kds/items/${q.items[0].id}/done`, cook);
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.status).toBe('picking');

    const h = await call('POST', `/api/v1/kds/handoff/${saladItem.order_item_id}`, picker);
    expect(h.statusCode, h.body).toBe(200);
    expect((await call('GET', '/api/v1/kds/queue?station=cold', cook)).json().items).toHaveLength(0);
    const moves = await ctx.deps.db.select().from(s.stockMove).where(and(eq(s.stockMove.refId, o.id), eq(s.stockMove.productId, tomato.id)));
    expect(moves.map((m) => m.qty)).toEqual([80]);
    const done = await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/complete`, picker);
    expect(done.statusCode, done.body).toBe(200);
  });

  it('товар другого бренда в заказе — отказ; блюдо Sor Box на точке без кухни — отказ', async () => {
    const [lab2] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'X', nameRu: 'Вода' }).returning();
    await ctx.deps.db.insert(s.price).values({ productId: lab2!.id, storeId: w.store.id, priceDirams: 500, validFrom: new Date('2026-01-01') });
    const sorWithLab = await call('PUT', '/api/v1/cart', w.token, { brand: 'SOR', store_id: w.store.id, items: [{ product_id: lab2!.id, qty: 1 }] });
    expect(sorWithLab.json().error.code).toBe('VALIDATION');
    await ctx.deps.db.update(s.store).set({ brands: ['LAB'] }).where(eq(s.store.id, w.store.id));
    const noKitchen = await call('PUT', '/api/v1/cart', w.token, { brand: 'LAB', store_id: w.store.id, items: [{ product_id: salad.id, qty: 1 }] });
    expect(noKitchen.json().error.code).toBe('VALIDATION');
  });
});
