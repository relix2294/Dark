import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { isValidEan13 } from '../src/shared/barcode.js';
import { planDailyStocktake } from '../src/modules/wms/index.js';

/** Склад по ТЗ §7: внутренние штрихкоды, сроки, инвентаризация от плана до применения, замена по звонку. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
const tok: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  for (const [i, role] of (['manager', 'shift_lead', 'picker'] as const).entries()) {
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: `+99290000040${i}`, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    tok[role] = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token;
  }
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

describe('склад (ТЗ §7)', () => {
  it('товар без штрихкода получает внутренний EAN-13', async () => {
    const r = await call('POST', '/api/v1/admin/products', tok.manager!, { brand: 'LAB', sku: 'NB-1', name_ru: 'Зелень пучок' });
    expect(r.statusCode, r.body).toBe(201);
    const code = r.json().barcodes[0];
    expect(code).toMatch(/^200/);
    expect(isValidEan13(code)).toBe(true);
    const r2 = await call('POST', '/api/v1/admin/products', tok.manager!, { brand: 'LAB', sku: 'NB-2', name_ru: 'Укроп' });
    expect(r2.json().barcodes[0]).not.toBe(code);
  });

  it('сроки: истёкшее — в списание, мало срока — на уценку, свежее не показывается', async () => {
    const day = 86_400_000;
    const now = ctx.deps.clock.now().getTime();
    const [cell] = await ctx.deps.db.select().from(s.cell).where(eq(s.cell.code, 'A-01-1'));
    await ctx.deps.db.update(s.product).set({ shelfLifeDays: 10 }).where(eq(s.product.id, w.p2.id));
    await ctx.deps.db.insert(s.stockLot).values([
      { storeId: w.store.id, productId: w.p2.id, cellId: cell!.id, qty: 3, expiresAt: new Date(now - day) },
      { storeId: w.store.id, productId: w.p2.id, cellId: cell!.id, qty: 4, expiresAt: new Date(now + 1.5 * day) },
      { storeId: w.store.id, productId: w.p2.id, cellId: cell!.id, qty: 5, expiresAt: new Date(now + 9 * day) },
    ]);
    const rows = (await call('GET', `/api/v1/admin/stores/${w.store.id}/expiring`, tok.shift_lead!)).json().rows;
    expect(rows.map((r: any) => [r.qty, r.action])).toEqual([
      [3, 'write_off'],
      [4, 'markdown'],
    ]);
  });

  it('инвентаризация: план дня с дорогим товаром, пересчёт, применение — недостача и излишек', async () => {
    const [hv] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'HV', nameRu: 'Наушники', barcodes: ['46099001'], isHighValue: true }).returning();
    const [cam] = await ctx.deps.db.insert(s.cell).values({ storeId: w.store.id, code: 'A-09-1', pickSeq: 9, isCameraCovered: true }).returning();
    await ctx.deps.db.insert(s.stockLot).values({ storeId: w.store.id, productId: hv!.id, cellId: cam!.id, qty: 5 });
    const plan = await ctx.deps.db.transaction((tx) => planDailyStocktake(tx, w.store.id));
    expect(plan.added).toBe(1);
    expect((await ctx.deps.db.transaction((tx) => planDailyStocktake(tx, w.store.id))).added).toBe(0);

    // полный пересчёт ячейки A-01-1 и A-09-1
    const st = await call('POST', `/api/v1/admin/stores/${w.store.id}/stocktakes`, tok.shift_lead!, { scope: 'cell', cell_codes: ['A-09-1', 'A-01-1'] });
    expect(st.statusCode, st.body).toBe(201);
    const id = st.json().id;
    const line = (code: string, pid: string) => st.json().lines.find((l: any) => l.cell_code === code && l.product_id === pid);
    expect(line('A-09-1', hv!.id).qty_system).toBe(5);

    await call('POST', `/api/v1/wms/stocktakes/${id}/count`, tok.picker!, { cell_code: 'A-09-1', product_id: hv!.id, qty_fact: 2 }); // недостача 3 > допуска → нужен второй
    expect((await call('POST', `/api/v1/admin/stores/${w.store.id}/stocktakes/${id}/apply`, tok.manager!)).json().error.code).toBe('VALIDATION');
    await call('POST', `/api/v1/wms/stocktakes/${id}/count`, tok.shift_lead!, { cell_code: 'A-09-1', product_id: hv!.id, qty_fact: 2 });
    await call('POST', `/api/v1/wms/stocktakes/${id}/count`, tok.shift_lead!, { cell_code: 'A-01-1', product_id: w.p1.id, qty_fact: 11 }); // излишек 1

    expect((await call('POST', `/api/v1/admin/stores/${w.store.id}/stocktakes/${id}/apply`, tok.shift_lead!)).statusCode).toBe(403);
    const ap = await call('POST', `/api/v1/admin/stores/${w.store.id}/stocktakes/${id}/apply`, tok.manager!);
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json()).toMatchObject({ adjusted: 2 });
    const hvLots = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, hv!.id));
    expect(hvLots.reduce((a, l) => a + l.qty, 0)).toBe(2);
    const p1Lots = await ctx.deps.db.select().from(s.stockLot).where(and(eq(s.stockLot.productId, w.p1.id), eq(s.stockLot.cellId, cam!.id)));
    expect(p1Lots).toHaveLength(0);
    const adj = await ctx.deps.db.select().from(s.stockMove).where(and(eq(s.stockMove.productId, w.p1.id), eq(s.stockMove.type, 'adjust')));
    expect(adj.map((m) => m.qty)).toEqual([1]);
    expect((await call('POST', `/api/v1/admin/stores/${w.store.id}/stocktakes/${id}/apply`, tok.manager!)).json().error.code).toBe('INVALID_TRANSITION');
  });

  it('замена по звонку: позиция убрана, таймер 60 с, клиент согласился — аналог', async () => {
    const [cat] = await ctx.deps.db.insert(s.category).values({ brand: 'LAB', name: 'Сыры' }).returning();
    const [a] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'CH-1', nameRu: 'Сыр гауда', barcodes: ['46088001'], categoryId: cat!.id }).returning();
    const [b] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'CH-2', nameRu: 'Сыр эдам', barcodes: ['46088002'], categoryId: cat!.id }).returning();
    await ctx.deps.db.insert(s.price).values([
      { productId: a!.id, storeId: w.store.id, priceDirams: 3000, validFrom: new Date('2026-01-01') },
      { productId: b!.id, storeId: w.store.id, priceDirams: 2800, validFrom: new Date('2026-01-01') },
    ]);
    const [cell] = await ctx.deps.db.select().from(s.cell).where(eq(s.cell.code, 'A-01-1'));
    await ctx.deps.db.insert(s.stockLot).values([
      { storeId: w.store.id, productId: a!.id, cellId: cell!.id, qty: 1 },
      { storeId: w.store.id, productId: b!.id, cellId: cell!.id, qty: 3 },
    ]);
    const o = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: a!.id, qty: 1, replace_policy: 'call' }], expected_total_dirams: 4000 });
    expect(o.statusCode, o.body).toBe(201);
    const t = (await call('GET', '/api/v1/wms/pick-tasks/next', tok.picker!)).json();
    const m = (await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/missing`, tok.picker!, { order_item_id: t.items[0].order_item_id })).json();
    expect(m.items[0].status).toBe('missing');
    expect(new Date(m.items[0].call_deadline).getTime() - ctx.deps.clock.now().getTime()).toBe(60_000);
    const d = await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/missing`, tok.picker!, { order_item_id: t.items[0].order_item_id, decision: 'auto' });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().items).toEqual([expect.objectContaining({ product_id: b!.id, status: 'pending', call_deadline: null })]);
    // второй раз решение не принимается
    const again = await call('POST', `/api/v1/wms/pick-tasks/${t.task_id}/missing`, tok.picker!, { order_item_id: t.items[0].order_item_id, decision: 'remove' });
    expect(again.statusCode).toBe(409);
  });
});
