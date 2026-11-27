import { and, asc, eq, inArray, isNull, lte, or, gt, sql } from 'drizzle-orm';
import type { StaffPrincipal, TempZone } from '@dark/contracts';
import type { PickTaskView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import {
  cell,
  order,
  pickTask,
  price,
  product,
  stockLot,
  stocktake,
  stocktakeLine,
  supply,
  supplyItem,
} from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { loadParams } from '../../shared/params/load.js';
import {
  addReplacementItem,
  getItemsWithProducts,
  markItemMissing,
  markItemPicked,
  pendingItemIds,
  recalcTotals,
  transition,
} from '../orders/index.js';
import { pickFromLot, placeLot, receiveLot, reserveForOrder, reservedByLot, unreserve, writeOffLot } from './stock.js';
import { neighborsOf, rejectCell, suggestCells, type CellCandidate } from './placement.js';

/**
 * Сервис склада: сборка, приёмка, размещение, списание, инвентаризация (ТЗ §7).
 * Таблицы заказа меняются только через функции модуля orders.
 */

const storeOf = (me: StaffPrincipal): string => {
  if (!me.store_id) throw new AppError('FORBIDDEN', 'Сотрудник не привязан к точке');
  return me.store_id;
};

// ---------- сборка ----------

export async function nextPickTask(deps: AppDeps, me: StaffPrincipal): Promise<PickTaskView | null> {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [open] = await tx.select().from(pickTask).where(and(eq(pickTask.pickerId, me.staff_id), eq(pickTask.status, 'open')));
    if (open) return taskView(tx, open);

    const [next] = await tx
      .select()
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.brand, 'LAB'), eq(order.status, 'paid_hold')))
      .orderBy(asc(order.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!next) return null;

    const [task] = await tx.insert(pickTask).values({ orderId: next.id, storeId, pickerId: me.staff_id, startedAt: deps.clock.now() }).returning();
    await transition(tx, next.id, 'paid_hold', 'picking', 'staff', me.staff_id, { picker_id: me.staff_id });
    return taskView(tx, task!);
  });
}

async function loadTask(tx: Tx, me: StaffPrincipal, taskId: string) {
  const [task] = await tx.select().from(pickTask).where(eq(pickTask.id, taskId)).for('update');
  if (!task) throw notFound('Задание', taskId);
  if (task.pickerId !== me.staff_id && !['shift_lead', 'manager'].includes(me.role)) throw new AppError('FORBIDDEN', 'Чужое задание');
  if (task.status !== 'open') throw new AppError('INVALID_TRANSITION', 'Задание уже завершено');
  return task;
}

export async function taskView(tx: Tx, task: typeof pickTask.$inferSelect): Promise<PickTaskView> {
  const [o] = await tx.select().from(order).where(eq(order.id, task.orderId));
  const rows = await getItemsWithProducts(tx, task.orderId);
  const reserved = await reservedByLot(tx, rows.map((r) => r.item.id));
  const items = rows
    .filter((r) => r.item.status !== 'replaced')
    .map(({ item, product: p }) => {
      const cells = reserved
        .filter((r) => r.refId === item.id)
        .map((r) => ({ cell_code: r.cellCode ?? '—', qty: r.qty, pick_seq: r.pickSeq ?? 9999 }))
        .sort((a, b) => a.pick_seq - b.pick_seq);
      return {
        order_item_id: item.id,
        product_id: item.productId,
        name: item.nameSnapshot,
        barcodes: p.barcodes,
        is_weighted: p.isWeighted,
        temp_zone: p.tempZone,
        qty_ordered: item.qtyOrdered,
        qty_picked: item.qtyPicked,
        status: item.status,
        cells,
      };
    })
    // порядок обхода: по первой ячейке позиции (ТЗ §7)
    .sort((a, b) => (a.cells[0]?.pick_seq ?? 9999) - (b.cells[0]?.pick_seq ?? 9999));
  return {
    task_id: task.id,
    order_id: task.orderId,
    order_number: o!.number,
    started_at: task.startedAt.toISOString(),
    sla_ms: (await loadParams(tx, task.storeId)).LAB_PICK_SLA_MS,
    comment: o!.comment,
    items,
  };
}

export async function getTask(deps: AppDeps, me: StaffPrincipal, taskId: string) {
  return deps.db.transaction(async (tx) => taskView(tx, await loadTask(tx, me, taskId)));
}

/** Скан: ячейка → товар → количество. Несовпадение — WRONG_CELL / WRONG_PRODUCT, позиция не засчитывается. */
export async function scan(deps: AppDeps, me: StaffPrincipal, taskId: string, input: { cell_code: string; barcode: string; qty: number; weight_g?: number | undefined }) {
  return deps.db.transaction(async (tx) => {
    const task = await loadTask(tx, me, taskId);
    const rows = await getItemsWithProducts(tx, task.orderId);
    const hit = rows.find((r) => r.item.status === 'pending' && r.product.barcodes.includes(input.barcode));
    if (!hit) throw new AppError('WRONG_PRODUCT', 'Такого товара нет среди несобранных позиций заказа', { barcode: input.barcode });
    const [c] = await tx.select().from(cell).where(and(eq(cell.storeId, task.storeId), eq(cell.code, input.cell_code)));
    if (!c) throw new AppError('WRONG_CELL', 'Ячейка не найдена', { cell_code: input.cell_code });

    const reserved = (await reservedByLot(tx, [hit.item.id])).filter((r) => r.cellId === c.id);
    if (reserved.length === 0) throw new AppError('WRONG_CELL', 'Товар этого заказа лежит в другой ячейке', { cell_code: input.cell_code });

    const weighted = hit.product.isWeighted;
    if (weighted && !input.weight_g) throw new AppError('VALIDATION', 'Для весового товара нужен weight_g');
    let need = weighted ? input.weight_g! : Math.min(input.qty, hit.item.qtyOrdered - hit.item.qtyPicked);
    const totalReservedHere = reserved.reduce((a, r) => a + r.qty, 0);
    if (!weighted && need > totalReservedHere) need = totalReservedHere;

    for (const r of reserved) {
      if (need === 0) break;
      const take = weighted ? need : Math.min(need, r.qty);
      await pickFromLot(tx, r.lotId, hit.item.id, take, r.qty);
      need -= take;
    }
    const picked = weighted ? input.weight_g! : Math.min(input.qty, hit.item.qtyOrdered - hit.item.qtyPicked);
    const res = await markItemPicked(tx, hit.item.id, picked, weighted);
    if (weighted) await unreserve(tx, [hit.item.id]); // остаток резерва после взвешивания
    if (res.done) await recalcTotals(tx, task.orderId);
    return taskView(tx, task);
  });
}

/** Товара нет: по replace_policy — call / auto / remove (ТЗ §7 п.4). Ячейка попадает в инвентаризацию дня (ТЗ §11). */
export async function missing(deps: AppDeps, me: StaffPrincipal, taskId: string, itemId: string, decision?: 'auto' | 'remove') {
  return deps.db.transaction(async (tx) => {
    const task = await loadTask(tx, me, taskId);
    const rows = await getItemsWithProducts(tx, task.orderId);
    const hit = rows.find((r) => r.item.id === itemId);
    if (!hit) throw notFound('Позиция', itemId);
    if (hit.item.status !== 'pending') throw new AppError('INVALID_TRANSITION', `Позиция уже ${hit.item.status}`);

    // ячейки с недобором — на пересчёт и обнуление остатка до инвентаризации
    const reserved = await reservedByLot(tx, [itemId]);
    await unreserve(tx, [itemId]);
    for (const r of reserved) await markCellForStocktake(tx, task.storeId, r.cellId, hit.item.productId, me.staff_id);

    const policy = decision ?? hit.item.replacePolicy;
    const meta: Record<string, unknown> = { policy, by: me.staff_id, at: deps.clock.now().toISOString() };

    if (policy === 'auto') {
      const alt = await findReplacement(tx, deps, task.storeId, hit.product, hit.item.priceDirams, hit.item.qtyOrdered);
      if (alt) {
        const ni = await addReplacementItem(tx, hit.item, alt, meta);
        await reserveForOrder(tx, task.storeId, task.orderId, [{ orderItemId: ni.id, productId: alt.id, qty: ni.qtyOrdered }], deps.clock.now(), (await loadParams(tx, task.storeId)).MIN_SHELF_LIFE_PCT);
      } else {
        await markItemMissing(tx, itemId, { ...meta, fallback: 'remove', reason: 'нет аналога' });
      }
    } else {
      // call: звонок клиенту — терминал показывает таймер 60 с; решение приходит повторным вызовом с decision.
      await markItemMissing(tx, itemId, policy === 'call' ? { ...meta, call_required: true } : meta);
    }
    await recalcTotals(tx, task.orderId);
    await publish(tx, { topic: 'order.item_replaced', aggregateType: 'order', aggregateId: task.orderId, payload: { item_id: itemId, policy } });
    return taskView(tx, task);
  });
}

async function findReplacement(tx: Tx, deps: AppDeps, storeId: string, p: typeof product.$inferSelect, maxPrice: number, qty: number) {
  const now = deps.clock.now();
  const rows = await tx
    .select({ id: product.id, nameRu: product.nameRu, priceDirams: price.priceDirams })
    .from(product)
    .innerJoin(price, and(eq(price.productId, product.id), eq(price.storeId, storeId), lte(price.validFrom, now), or(isNull(price.validTo), gt(price.validTo, now))))
    .where(
      and(
        eq(product.brand, p.brand),
        eq(product.isActive, true),
        p.categoryId ? eq(product.categoryId, p.categoryId) : sql`false`,
        sql`${product.id} <> ${p.id}`,
        eq(product.isWeighted, p.isWeighted),
        lte(price.priceDirams, maxPrice),
        sql`(select coalesce(sum(${stockLot.qty} - ${stockLot.reservedQty}), 0) from ${stockLot}
             where ${stockLot.productId} = ${product.id} and ${stockLot.storeId} = ${storeId}) >= ${qty}`,
      ),
    )
    .orderBy(sql`${price.priceDirams} desc`)
    .limit(1);
  return rows[0] ?? null;
}

async function markCellForStocktake(tx: Tx, storeId: string, cellId: string | null, productId: string, actorId: string) {
  if (!cellId) return;
  const [open] = await tx.select().from(stocktake).where(and(eq(stocktake.storeId, storeId), eq(stocktake.status, 'open'), eq(stocktake.scope, 'daily')));
  const st = open ?? (await tx.insert(stocktake).values({ storeId, scope: 'daily', status: 'open' }).returning())[0]!;
  const [sys] = await tx
    .select({ q: sql<number>`coalesce(sum(${stockLot.qty}), 0)::int` })
    .from(stockLot)
    .where(and(eq(stockLot.cellId, cellId), eq(stockLot.productId, productId)));
  const exists = await tx.select().from(stocktakeLine).where(and(eq(stocktakeLine.stocktakeId, st.id), eq(stocktakeLine.cellId, cellId), eq(stocktakeLine.productId, productId)));
  if (exists.length === 0) await tx.insert(stocktakeLine).values({ stocktakeId: st.id, cellId, productId, qtySystem: sys?.q ?? 0, countedBy: null, recountRequired: true });
  void actorId;
}

/** Сборка окончена: все позиции picked / replaced / missing → ready, ярлык пакета. */
export async function complete(deps: AppDeps, me: StaffPrincipal, taskId: string) {
  return deps.db.transaction(async (tx) => {
    const task = await loadTask(tx, me, taskId);
    const pending = await pendingItemIds(tx, task.orderId);
    if (pending.length) throw new AppError('INVALID_TRANSITION', 'Есть несобранные позиции', { pending_item_ids: pending });
    const rows = await getItemsWithProducts(tx, task.orderId);
    const delivered = rows.filter((r) => r.item.status === 'picked');
    if (delivered.length === 0) throw new AppError('INVALID_TRANSITION', 'В заказе не осталось позиций — отмена через старшего смены');
    const totals = await recalcTotals(tx, task.orderId);
    const [o] = await tx.select().from(order).where(eq(order.id, task.orderId));
    const barcode = `PKG-${o!.number}`;
    await tx.update(pickTask).set({ status: 'done', completedAt: deps.clock.now(), labelBarcode: barcode }).where(eq(pickTask.id, task.id));
    await transition(tx, task.orderId, 'picking', 'ready', 'staff', me.staff_id, { pick_ms: deps.clock.now().getTime() - task.startedAt.getTime() });
    return {
      order_number: o!.number,
      barcode,
      temp_zones: [...new Set(delivered.map((r) => r.product.tempZone))] as TempZone[],
      items_total_dirams: totals.itemsTotal,
    };
  });
}

// ---------- приёмка и размещение ----------

export async function supplyView(deps: AppDeps, me: StaffPrincipal, supplyId: string) {
  const [s] = await deps.db.select().from(supply).where(and(eq(supply.id, supplyId), eq(supply.storeId, storeOf(me))));
  if (!s) throw notFound('Поставка', supplyId);
  const items = await deps.db
    .select({ product_id: supplyItem.productId, name: product.nameRu, barcodes: product.barcodes, qty_expected: supplyItem.qtyExpected, qty_received: supplyItem.qtyReceived })
    .from(supplyItem)
    .innerJoin(product, eq(product.id, supplyItem.productId))
    .where(eq(supplyItem.supplyId, supplyId));
  return { id: s.id, supplier: s.supplier, status: s.status, items };
}

export async function receive(deps: AppDeps, me: StaffPrincipal, supplyId: string, input: { barcode: string; qty: number; expires_at?: string | undefined }) {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(supply).where(and(eq(supply.id, supplyId), eq(supply.storeId, storeId))).for('update');
    if (!s) throw notFound('Поставка', supplyId);
    const [p] = await tx.select().from(product).where(sql`${input.barcode} = any(${product.barcodes})`);
    if (!p) throw new AppError('WRONG_PRODUCT', 'Штрихкод не найден — заведите товар или напечатайте внутренний', { barcode: input.barcode });
    const [line] = await tx.select().from(supplyItem).where(and(eq(supplyItem.supplyId, supplyId), eq(supplyItem.productId, p.id)));
    // расхождение с документом фиксируется: товара нет в поставке — строка с qty_expected 0
    if (line) await tx.update(supplyItem).set({ qtyReceived: sql`${supplyItem.qtyReceived} + ${input.qty}` }).where(eq(supplyItem.id, line.id));
    else await tx.insert(supplyItem).values({ supplyId, productId: p.id, qtyExpected: 0, qtyReceived: input.qty });
    const lot = await receiveLot(tx, { storeId, productId: p.id, qty: input.qty, expiresAt: input.expires_at ? new Date(input.expires_at) : null, supplyId, actorId: me.staff_id });
    if (s.status === 'expected') await tx.update(supply).set({ status: 'receiving' }).where(eq(supply.id, supplyId));
    return lotView(lot, null);
  });
}

const lotView = (l: typeof stockLot.$inferSelect, cellCode: string | null) => ({
  lot_id: l.id,
  product_id: l.productId,
  cell_code: cellCode,
  qty: l.qty,
  reserved_qty: l.reservedQty,
  expires_at: l.expiresAt?.toISOString() ?? null,
});

/** Кандидаты ячеек для размещения партии (ТЗ §7). */
async function cellCandidates(tx: Tx, storeId: string, productId: string): Promise<{ cells: CellCandidate[]; p: typeof product.$inferSelect; fast: boolean }> {
  const [p] = await tx.select().from(product).where(eq(product.id, productId));
  if (!p) throw notFound('Товар', productId);
  const cells = await tx.select().from(cell).where(and(eq(cell.storeId, storeId), eq(cell.isActive, true)));
  const contents = await tx
    .select({ cellId: stockLot.cellId, productId: stockLot.productId, qty: stockLot.qty, name: product.nameRu, categoryId: product.categoryId })
    .from(stockLot)
    .innerJoin(product, eq(product.id, stockLot.productId))
    .where(and(eq(stockLot.storeId, storeId), inArray(stockLot.cellId, cells.map((c) => c.id))));
  // ходовой товар: топ-20 % по частоте заказов за 30 дней
  const [rank] = await tx.execute<{ fast: boolean }>(sql`
    with freq as (
      select oi.product_id, count(*) n from order_item oi join "order" o on o.id = oi.order_id
      where o.store_id = ${storeId} and o.created_at > now() - interval '30 days' group by oi.product_id),
    ranked as (select product_id, percent_rank() over (order by n desc) pr from freq)
    select coalesce((select pr <= 0.2 from ranked where product_id = ${productId}), false) as fast`).then((r) => r.rows);
  const candidates: CellCandidate[] = cells.map((c) => ({
    id: c.id,
    code: c.code,
    tempZone: c.tempZone,
    isCameraCovered: c.isCameraCovered,
    pickSeq: c.pickSeq,
    capacityUnits: c.capacityUnits,
    usedUnits: contents.filter((x) => x.cellId === c.id).reduce((a, x) => a + x.qty, 0),
    // сам товар рядом с собой — норма; без категории правило соседства не применяется
    sameCategoryNames: contents
      .filter((x) => x.cellId === c.id && x.productId !== p.id && p.categoryId !== null && x.categoryId === p.categoryId)
      .map((x) => x.name),
  }));
  return { cells: candidates, p, fast: rank?.fast ?? false };
}

export async function suggestPlacement(deps: AppDeps, me: StaffPrincipal, lotId: string) {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [lot] = await tx.select().from(stockLot).where(and(eq(stockLot.id, lotId), eq(stockLot.storeId, storeId)));
    if (!lot) throw notFound('Партия', lotId);
    const { cells, p, fast } = await cellCandidates(tx, storeId, lot.productId);
    const ranked = suggestCells(cells, toPlaceProduct(p, fast, lot.qty - lot.reservedQty));
    return { lot_id: lotId, suggested: ranked.slice(0, 5).map((c) => ({ cell_code: c.code, free_units: c.capacityUnits - c.usedUnits, pick_seq: c.pickSeq })) };
  });
}

const toPlaceProduct = (p: typeof product.$inferSelect, fast: boolean, qty: number) => ({
  id: p.id,
  nameRu: p.nameRu,
  categoryId: p.categoryId,
  tempZone: p.tempZone,
  isHighValue: p.isHighValue,
  isFastMover: fast,
  qty,
});

export async function place(deps: AppDeps, me: StaffPrincipal, input: { lot_id: string; cell_code: string; qty: number }) {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [lot] = await tx.select().from(stockLot).where(and(eq(stockLot.id, input.lot_id), eq(stockLot.storeId, storeId)));
    if (!lot) throw notFound('Партия', input.lot_id);
    const { cells, p, fast } = await cellCandidates(tx, storeId, lot.productId);
    const target = cells.find((c) => c.code === input.cell_code);
    if (!target) throw new AppError('WRONG_CELL', 'Ячейка не найдена', { cell_code: input.cell_code });
    const why = rejectCell(target, neighborsOf(target, cells), toPlaceProduct(p, fast, input.qty));
    if (why) throw new AppError('WRONG_CELL', `Ячейка недопустима: ${REJECT_TEXT[why]}`, { cell_code: input.cell_code, reason: why });
    const newLotId = await placeLot(tx, lot.id, target.id, input.qty, me.staff_id);
    const [nl] = await tx.select().from(stockLot).where(eq(stockLot.id, newLotId));
    return lotView(nl!, target.code);
  });
}

const REJECT_TEXT = {
  temp_zone: 'другая температурная зона',
  needs_camera: 'дорогой товар только под камеру',
  similar_neighbor: 'рядом похожий товар той же категории',
  no_space: 'нет места',
} as const;

// ---------- списание и инвентаризация ----------

export async function writeOff(deps: AppDeps, me: StaffPrincipal, input: { lot_id: string; qty: number; reason: string; photo_url?: string | undefined }) {
  const storeId = storeOf(me);
  const canApprove = ['shift_lead', 'manager'].includes(me.role);
  return deps.db.transaction(async (tx) => {
    const [lot] = await tx.select().from(stockLot).where(and(eq(stockLot.id, input.lot_id), eq(stockLot.storeId, storeId)));
    if (!lot) throw notFound('Партия', input.lot_id);
    if (!canApprove) {
      // сборщик/повар только запрашивают (ТЗ §9) — запрос фиксируется событием для старшего смены
      await publish(tx, { topic: 'stock.low', aggregateType: 'stock_lot', aggregateId: lot.id, payload: { write_off_requested: input, by: me.staff_id } });
      return { status: 'requested' as const, lot: lotView(lot, null) };
    }
    await writeOffLot(tx, lot.id, input.qty, input.reason + (input.photo_url ? ` (фото: ${input.photo_url})` : ''), me.staff_id);
    const [after] = await tx.select().from(stockLot).where(eq(stockLot.id, lot.id));
    return { status: 'done' as const, lot: lotView(after!, null) };
  });
}

export async function count(deps: AppDeps, me: StaffPrincipal, stocktakeId: string, input: { cell_code: string; product_id: string; qty_fact: number }) {
  const storeId = storeOf(me);
  return deps.db.transaction(async (tx) => {
    const [st] = await tx.select().from(stocktake).where(and(eq(stocktake.id, stocktakeId), eq(stocktake.storeId, storeId), eq(stocktake.status, 'open')));
    if (!st) throw notFound('Инвентаризация', stocktakeId);
    const [c] = await tx.select().from(cell).where(and(eq(cell.storeId, storeId), eq(cell.code, input.cell_code)));
    if (!c) throw new AppError('WRONG_CELL', 'Ячейка не найдена', { cell_code: input.cell_code });
    const [sys] = await tx
      .select({ q: sql<number>`coalesce(sum(${stockLot.qty}), 0)::int` })
      .from(stockLot)
      .where(and(eq(stockLot.cellId, c.id), eq(stockLot.productId, input.product_id)));
    const qtySystem = sys?.q ?? 0;
    const tolerance = Math.max(1, Math.round((qtySystem * (await loadParams(tx, storeId)).STOCKTAKE_TOLERANCE_PCT) / 100));
    const [existing] = await tx.select().from(stocktakeLine).where(and(eq(stocktakeLine.stocktakeId, st.id), eq(stocktakeLine.cellId, c.id), eq(stocktakeLine.productId, input.product_id)));
    // повторный пересчёт другим сотрудником снимает флаг; тем же — нет (ТЗ §7)
    const diffBig = Math.abs(input.qty_fact - qtySystem) > tolerance;
    const recountRequired = diffBig && (!existing?.countedBy || existing.countedBy === me.staff_id);
    if (existing) {
      await tx.update(stocktakeLine).set({ qtySystem, qtyFact: input.qty_fact, countedBy: me.staff_id, recountRequired }).where(eq(stocktakeLine.id, existing.id));
    } else {
      await tx.insert(stocktakeLine).values({ stocktakeId: st.id, cellId: c.id, productId: input.product_id, qtySystem, qtyFact: input.qty_fact, countedBy: me.staff_id, recountRequired });
    }
    return { cell_code: c.code, product_id: input.product_id, qty_system: qtySystem, qty_fact: input.qty_fact, recount_required: recountRequired };
  });
}
