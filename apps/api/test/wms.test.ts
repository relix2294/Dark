import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let lead: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000011', name: 'Сборщик', role: 'picker', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  const [l] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000014', name: 'Старший', role: 'shift_lead', storeId: w.store.id, pinHash: hashPin('1234') }).returning();
  picker = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'picker', store_id: w.store.id })).token;
  lead = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: l!.id, role: 'shift_lead', store_id: w.store.id })).token;
});
afterAll(async () => ctx.close());

const call = async (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } });

async function placeOrder(items: { product_id: string; qty: number; replace_policy?: string }[], total: number) {
  const r = await call('POST', '/api/v1/orders', w.token, { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items, expected_total_dirams: total });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

describe('сборка (ТЗ §7)', () => {
  it('нет заданий → null; заказ появился → задание с ячейками в порядке обхода', async () => {
    expect((await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json()).toBeNull();
    const o = await placeOrder([{ product_id: w.p1.id, qty: 2 }, { product_id: w.p2.id, qty: 1, replace_policy: 'remove' }], 2500 + 1100 + 1000);
    const t = await call('GET', '/api/v1/wms/pick-tasks/next', picker);
    expect(t.statusCode, t.body).toBe(200);
    const task = t.json();
    expect(task.order_id).toBe(o.id);
    expect(task.items).toHaveLength(2);
    expect(task.items[0].cells[0]).toMatchObject({ cell_code: 'A-01-1', qty: 2 });
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.status).toBe('picking');
    // повторный вызов возвращает то же открытое задание
    expect((await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json().task_id).toBe(task.task_id);

    // неверная ячейка и неверный товар
    const wc = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/scan`, picker, { cell_code: 'Z-99-9', barcode: '1', qty: 1 });
    expect(wc.json().error.code).toBe('WRONG_CELL');
    const wp = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '999', qty: 1 });
    expect(wp.json().error.code).toBe('WRONG_PRODUCT');

    // собираем вафли по одной
    let v = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 1 });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().items.find((i: any) => i.product_id === w.p1.id)).toMatchObject({ qty_picked: 1, status: 'pending' });
    v = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: '1', qty: 1 });
    expect(v.json().items.find((i: any) => i.product_id === w.p1.id)).toMatchObject({ qty_picked: 2, status: 'picked' });
    const [lot1] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p1.id));
    expect(lot1).toMatchObject({ qty: 8, reservedQty: 0 });

    // нельзя завершить с несобранной позицией
    const early = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/complete`, picker);
    expect(early.json().error.code).toBe('INVALID_TRANSITION');

    // молока нет на полке: политика remove → позиция missing, резерв снят, сумма пересчитана, ячейка на пересчёт
    const milkItem = task.items.find((i: any) => i.product_id === w.p2.id);
    const m = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/missing`, picker, { order_item_id: milkItem.order_item_id });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().items.find((i: any) => i.product_id === w.p2.id).status).toBe('missing');
    const [lot2] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.productId, w.p2.id));
    expect(lot2!.reservedQty).toBe(0);
    const [ord2] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord2!.itemsTotalDirams).toBe(2500);
    expect(ord2!.totalDirams).toBe(3500);
    const lines = await ctx.deps.db.select().from(s.stocktakeLine);
    expect(lines.some((l) => l.productId === w.p2.id && l.recountRequired)).toBe(true);

    // завершение → ready + ярлык
    const done = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/complete`, picker);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ barcode: `PKG-${o.number}`, items_total_dirams: 2500 });
    const [ord3] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord3!.status).toBe('ready');
    expect(ord3!.readyAt).not.toBeNull();
  });

  it('автозамена: аналог той же категории не дороже и в наличии', async () => {
    const [cat] = await ctx.deps.db.insert(s.category).values({ brand: 'LAB', name: 'Вафли' }).returning();
    const [orig] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'W1', nameRu: 'Вафли ореховые', barcodes: ['w1'], categoryId: cat!.id }).returning();
    const [alt] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'W2', nameRu: 'Вафли сливочные', barcodes: ['w2'], categoryId: cat!.id }).returning();
    await ctx.deps.db.insert(s.price).values([
      { productId: orig!.id, storeId: w.store.id, priceDirams: 2000, validFrom: new Date('2026-01-01') },
      { productId: alt!.id, storeId: w.store.id, priceDirams: 1800, validFrom: new Date('2026-01-01') },
    ]);
    const [cell] = await ctx.deps.db.select().from(s.cell).where(eq(s.cell.code, 'A-01-1'));
    await ctx.deps.db.insert(s.stockLot).values([
      { storeId: w.store.id, productId: orig!.id, cellId: cell!.id, qty: 1 },
      { storeId: w.store.id, productId: alt!.id, cellId: cell!.id, qty: 5 },
    ]);
    const o = await placeOrder([{ product_id: orig!.id, qty: 1, replace_policy: 'auto' }], 3000);
    const task = (await call('GET', '/api/v1/wms/pick-tasks/next', picker)).json();
    const m = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/missing`, picker, { order_item_id: task.items[0].order_item_id });
    expect(m.statusCode, m.body).toBe(200);
    const items = m.json().items;
    expect(items).toHaveLength(1); // replaced скрыт, виден аналог
    expect(items[0]).toMatchObject({ product_id: alt!.id, status: 'pending' });
    const [ord] = await ctx.deps.db.select().from(s.order).where(eq(s.order.id, o.id));
    expect(ord!.itemsTotalDirams).toBe(1800);
    const v = await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/scan`, picker, { cell_code: 'A-01-1', barcode: 'w2', qty: 1 });
    expect(v.json().items[0].status).toBe('picked');
    expect((await call('POST', `/api/v1/wms/pick-tasks/${task.task_id}/complete`, picker)).statusCode).toBe(200);
  });
});

describe('приёмка, размещение, списание, пересчёт (ТЗ §7)', () => {
  it('приёмка создаёт партию без ячейки; расхождение с документом фиксируется', async () => {
    const [sup] = await ctx.deps.db.insert(s.supply).values({ storeId: w.store.id, supplier: 'ООО Поставщик' }).returning();
    await ctx.deps.db.insert(s.supplyItem).values({ supplyId: sup!.id, productId: w.p1.id, qtyExpected: 10 });
    const r = await call('POST', `/api/v1/wms/supplies/${sup!.id}/receive`, picker, { barcode: '1', qty: 12 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ cell_code: null, qty: 12 });
    const view = (await call('GET', `/api/v1/wms/supplies/${sup!.id}`, picker)).json();
    expect(view.items[0]).toMatchObject({ qty_expected: 10, qty_received: 12 });
    const unknown = await call('POST', `/api/v1/wms/supplies/${sup!.id}/receive`, picker, { barcode: 'nope', qty: 1 });
    expect(unknown.json().error.code).toBe('WRONG_PRODUCT');

    // размещение: подсказка и запрет чужой зоны / без камеры
    const lotId = r.json().lot_id;
    await ctx.deps.db.insert(s.cell).values([
      { storeId: w.store.id, code: 'A-02-1', pickSeq: 2 },
      { storeId: w.store.id, code: 'C-01-1', pickSeq: 20, tempZone: 'chill' },
      { storeId: w.store.id, code: 'A-03-1', pickSeq: 3, isCameraCovered: true },
    ]);
    const sug = (await call('GET', `/api/v1/wms/lots/${lotId}/suggest`, picker)).json();
    expect(sug.suggested.map((c: any) => c.cell_code)).not.toContain('C-01-1');
    const bad = await call('POST', '/api/v1/wms/place', picker, { lot_id: lotId, cell_code: 'C-01-1', qty: 5 });
    expect(bad.json().error).toMatchObject({ code: 'WRONG_CELL', details: { reason: 'temp_zone' } });
    const ok = await call('POST', '/api/v1/wms/place', picker, { lot_id: lotId, cell_code: 'A-02-1', qty: 5 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ cell_code: 'A-02-1', qty: 5 });
    const [rest] = await ctx.deps.db.select().from(s.stockLot).where(eq(s.stockLot.id, lotId));
    expect(rest!.qty).toBe(7); // партия разделена

    // дорогой товар — только под камеру (правило + триггер БД)
    const [hv] = await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'HV', nameRu: 'Наушники', barcodes: ['hv'], isHighValue: true }).returning();
    await ctx.deps.db.insert(s.price).values({ productId: hv!.id, storeId: w.store.id, priceDirams: 50000, validFrom: new Date('2026-01-01') });
    const hvLot = await call('POST', `/api/v1/wms/supplies/${sup!.id}/receive`, picker, { barcode: 'hv', qty: 2 });
    const noCam = await call('POST', '/api/v1/wms/place', picker, { lot_id: hvLot.json().lot_id, cell_code: 'A-02-1', qty: 2 });
    expect(noCam.json().error.details.reason).toBe('needs_camera');
    const cam = await call('POST', '/api/v1/wms/place', picker, { lot_id: hvLot.json().lot_id, cell_code: 'A-03-1', qty: 2 });
    expect(cam.statusCode).toBe(200);
    const [c2] = await ctx.deps.db.select().from(s.cell).where(eq(s.cell.code, 'A-02-1'));
    await expect(ctx.deps.db.update(s.stockLot).set({ cellId: c2!.id }).where(eq(s.stockLot.id, hvLot.json().lot_id))).rejects.toSatisfy((e: any) =>
      String(e.cause?.message ?? e.message).includes('WRONG_CELL'),
    );
  });

  it('списание: сборщик только запрашивает, старший списывает; резерв списать нельзя', async () => {
    const [lot] = await ctx.deps.db.select().from(s.stockLot).where(and(eq(s.stockLot.productId, w.p1.id), eq(s.stockLot.qty, 7)));
    const req = await call('POST', '/api/v1/wms/write-off', picker, { lot_id: lot!.id, qty: 1, reason: 'бой' });
    expect(req.json().status).toBe('requested');
    const done = await call('POST', '/api/v1/wms/write-off', lead, { lot_id: lot!.id, qty: 1, reason: 'бой' });
    expect(done.json()).toMatchObject({ status: 'done', lot: { qty: 6 } });
    const tooMuch = await call('POST', '/api/v1/wms/write-off', lead, { lot_id: lot!.id, qty: 100, reason: 'x' });
    expect(tooMuch.json().error.code).toBe('OUT_OF_STOCK');
    const moves = await ctx.deps.db.select().from(s.stockMove).where(and(eq(s.stockMove.lotId, lot!.id), eq(s.stockMove.type, 'write_off')));
    expect(moves).toHaveLength(1);
  });

  it('инвентаризация: расхождение выше порога требует пересчёта другим сотрудником', async () => {
    const [st] = await ctx.deps.db.insert(s.stocktake).values({ storeId: w.store.id, scope: 'cell' }).returning();
    const r1 = await call('POST', `/api/v1/wms/stocktakes/${st!.id}/count`, picker, { cell_code: 'A-02-1', product_id: w.p1.id, qty_fact: 3 });
    expect(r1.json()).toMatchObject({ qty_system: 5, qty_fact: 3, recount_required: true });
    const same = await call('POST', `/api/v1/wms/stocktakes/${st!.id}/count`, picker, { cell_code: 'A-02-1', product_id: w.p1.id, qty_fact: 3 });
    expect(same.json().recount_required).toBe(true);
    const other = await call('POST', `/api/v1/wms/stocktakes/${st!.id}/count`, lead, { cell_code: 'A-02-1', product_id: w.p1.id, qty_fact: 3 });
    expect(other.json().recount_required).toBe(false);
  });
});
