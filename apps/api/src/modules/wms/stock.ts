import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/client.js';
import { cell, orderItem, product, stockLot, stockMove } from '../../shared/db/schema/index.js';
import { AppError } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { loadParams } from '../../shared/params/load.js';
import { ref } from '../../shared/db/sql.js';
import { planReserve } from './reserve.js';

/**
 * Движения остатков (ТЗ §7). Единственное место, где меняются stock_lot.qty / reserved_qty.
 * Каждое изменение — строка stock_move в той же транзакции (остаток = сумма движений).
 */

export type ReserveLine = { orderItemId: string; productId: string; qty: number };

/** Резерв FEFO с блокировкой строк партий. Недостача → OUT_OF_STOCK с product_ids. */
export async function reserveForOrder(tx: Tx, storeId: string, orderId: string, lines: ReserveLine[], now: Date, minShelfLifePct: number) {
  const short: string[] = [];
  for (const it of lines) {
    const lots = await tx
      .select()
      .from(stockLot)
      .where(and(eq(stockLot.storeId, storeId), eq(stockLot.productId, it.productId), sql`${stockLot.qty} > ${stockLot.reservedQty}`))
      .orderBy(stockLot.expiresAt, stockLot.createdAt)
      .for('update');
    const { plan, shortage } = planReserve(
      lots.map((l) => ({ id: l.id, qty: l.qty, reservedQty: l.reservedQty, expiresAt: l.expiresAt, receivedAt: l.createdAt, shelfLifeDays: null })),
      it.qty,
      now,
      minShelfLifePct,
    );
    if (shortage > 0) {
      short.push(it.productId);
      continue;
    }
    for (const r of plan) {
      await tx.update(stockLot).set({ reservedQty: sql`${stockLot.reservedQty} + ${r.qty}` }).where(eq(stockLot.id, r.lotId));
      await tx.insert(stockMove).values({
        storeId,
        productId: it.productId,
        lotId: r.lotId,
        type: 'reserve',
        qty: r.qty,
        refType: 'order_item',
        refId: it.orderItemId,
      });
    }
  }
  if (short.length) throw new AppError('OUT_OF_STOCK', 'Товар закончился во время оформления', { product_ids: short });
  await checkStockLevel(tx, storeId, lines.map((l) => l.productId));
}

/** Остаток резерва заказа/позиции по партиям: reserve − unreserve − pick. */
export async function reservedByLot(tx: Tx, refIds: string[]) {
  if (refIds.length === 0) return [];
  const rows = await tx
    .select({
      refId: stockMove.refId,
      lotId: stockMove.lotId,
      productId: stockMove.productId,
      storeId: stockMove.storeId,
      qty: sql<number>`sum(case ${stockMove.type} when 'reserve' then ${stockMove.qty} else -${stockMove.qty} end)::int`,
      cellId: stockLot.cellId,
      cellCode: cell.code,
      pickSeq: cell.pickSeq,
    })
    .from(stockMove)
    .innerJoin(stockLot, eq(stockLot.id, stockMove.lotId))
    .leftJoin(cell, eq(cell.id, stockLot.cellId))
    .where(and(eq(stockMove.refType, 'order_item'), inArray(stockMove.refId, refIds), inArray(stockMove.type, ['reserve', 'unreserve', 'pick'])))
    .groupBy(stockMove.refId, stockMove.lotId, stockMove.productId, stockMove.storeId, stockLot.cellId, cell.code, cell.pickSeq);
  return rows.filter((r) => r.qty > 0) as Array<(typeof rows)[number] & { refId: string; lotId: string }>;
}

/** Снять остаток резерва по позициям (отмена, недобор, отказ банка). */
export async function unreserve(tx: Tx, orderItemIds: string[]) {
  for (const r of await reservedByLot(tx, orderItemIds)) {
    await tx.update(stockLot).set({ reservedQty: sql`${stockLot.reservedQty} - ${r.qty}` }).where(eq(stockLot.id, r.lotId));
    await tx.insert(stockMove).values({ storeId: r.storeId, productId: r.productId, lotId: r.lotId, type: 'unreserve', qty: r.qty, refType: 'order_item', refId: r.refId });
  }
}

/**
 * Списать собранное из партии: qty и reserved_qty уменьшаются. reserved уменьшается не больше, чем зарезервировано
 * по этой позиции в этой партии (весовой товар может весить больше резерва).
 */
export async function pickFromLot(tx: Tx, lotId: string, orderItemId: string, qty: number, reservedHere: number) {
  const [lot] = await tx.select().from(stockLot).where(eq(stockLot.id, lotId)).for('update');
  if (!lot) throw new AppError('NOT_FOUND', 'Партия не найдена');
  const free = lot.qty - lot.reservedQty + reservedHere; // доступно этой позиции
  if (qty > free) throw new AppError('OUT_OF_STOCK', 'В партии меньше, чем сканируется', { lot_id: lotId, available: free });
  const releaseReserved = Math.min(reservedHere, qty);
  await tx
    .update(stockLot)
    .set({ qty: sql`${stockLot.qty} - ${qty}`, reservedQty: sql`${stockLot.reservedQty} - ${releaseReserved}` })
    .where(eq(stockLot.id, lotId));
  // pick уменьшает резерв на releaseReserved; излишек веса — отдельным движением без ссылки на резерв
  if (releaseReserved > 0)
    await tx.insert(stockMove).values({ storeId: lot.storeId, productId: lot.productId, lotId, type: 'pick', qty: releaseReserved, refType: 'order_item', refId: orderItemId });
  if (qty > releaseReserved)
    await tx.insert(stockMove).values({ storeId: lot.storeId, productId: lot.productId, lotId, type: 'pick', qty: qty - releaseReserved, refType: 'order_item_extra', refId: orderItemId });
  // сборка весового сверх резерва уменьшает доступное
  if (qty > releaseReserved) await checkStockLevel(tx, lot.storeId, [lot.productId]);
}

/** Приёмка: новая партия без ячейки. */
export async function receiveLot(tx: Tx, p: { storeId: string; productId: string; qty: number; expiresAt: Date | null; supplyId: string | null; actorId: string }) {
  const [lot] = await tx.insert(stockLot).values({ storeId: p.storeId, productId: p.productId, qty: p.qty, expiresAt: p.expiresAt, supplyId: p.supplyId }).returning();
  await tx.insert(stockMove).values({ storeId: p.storeId, productId: p.productId, lotId: lot!.id, type: 'receive', qty: p.qty, refType: 'supply', refId: p.supplyId, actorId: p.actorId });
  return lot!;
}

/** Размещение: перенести qty из партии в ячейку. Частичное — разделить партию. */
export async function placeLot(tx: Tx, lotId: string, cellId: string, qty: number, actorId: string) {
  const [lot] = await tx.select().from(stockLot).where(eq(stockLot.id, lotId)).for('update');
  if (!lot) throw new AppError('NOT_FOUND', 'Партия не найдена');
  const movable = lot.qty - lot.reservedQty;
  if (qty > movable) throw new AppError('OUT_OF_STOCK', 'Нельзя переместить зарезервированное', { movable });
  let targetLotId = lotId;
  if (qty === lot.qty) {
    await tx.update(stockLot).set({ cellId }).where(eq(stockLot.id, lotId));
  } else {
    await tx.update(stockLot).set({ qty: sql`${stockLot.qty} - ${qty}` }).where(eq(stockLot.id, lotId));
    const [nl] = await tx
      .insert(stockLot)
      .values({ storeId: lot.storeId, productId: lot.productId, cellId, qty, expiresAt: lot.expiresAt, supplyId: lot.supplyId })
      .returning();
    targetLotId = nl!.id;
  }
  await tx.insert(stockMove).values({ storeId: lot.storeId, productId: lot.productId, lotId: targetLotId, type: 'place', qty, refType: 'cell', refId: cellId, actorId });
  return targetLotId;
}

export async function writeOffLot(tx: Tx, lotId: string, qty: number, reason: string, actorId: string) {
  const [lot] = await tx.select().from(stockLot).where(eq(stockLot.id, lotId)).for('update');
  if (!lot) throw new AppError('NOT_FOUND', 'Партия не найдена');
  if (qty > lot.qty - lot.reservedQty) throw new AppError('OUT_OF_STOCK', 'Нельзя списать зарезервированное', { available: lot.qty - lot.reservedQty });
  await tx.update(stockLot).set({ qty: sql`${stockLot.qty} - ${qty}` }).where(eq(stockLot.id, lotId));
  await tx.insert(stockMove).values({ storeId: lot.storeId, productId: lot.productId, lotId, type: 'write_off', qty, reason, actorId });
  await checkStockLevel(tx, lot.storeId, [lot.productId]);
}

/** Корректировка после пересчёта: до факта. Только управляющий (ТЗ §9). */
export async function adjustLot(tx: Tx, lotId: string, qtyFact: number, reason: string, actorId: string) {
  const [lot] = await tx.select().from(stockLot).where(eq(stockLot.id, lotId)).for('update');
  if (!lot) throw new AppError('NOT_FOUND', 'Партия не найдена');
  const diff = qtyFact - lot.qty;
  if (diff === 0) return;
  if (qtyFact < lot.reservedQty) throw new AppError('OUT_OF_STOCK', 'Факт меньше резерва', { reserved: lot.reservedQty });
  await tx.update(stockLot).set({ qty: qtyFact }).where(eq(stockLot.id, lotId));
  await tx.insert(stockMove).values({ storeId: lot.storeId, productId: lot.productId, lotId, type: 'adjust', qty: diff, reason, actorId });
  if (diff < 0) await checkStockLevel(tx, lot.storeId, [lot.productId]);
}

/**
 * Расход ингредиентов кухни по рецептуре (ТЗ §8, этап 1: учёт без резерва). Если партия ингредиента есть —
 * списываем из неё (не ниже нуля и не трогая резерв), иначе фиксируем расход движением без партии.
 */
export async function consumeIngredients(tx: Tx, storeId: string, orderId: string, lines: { productId: string; grams: number }[], actorId: string, reason = 'recipe') {
  for (const l of lines) {
    if (l.grams <= 0) continue;
    const [lot] = await tx
      .select()
      .from(stockLot)
      .where(and(eq(stockLot.storeId, storeId), eq(stockLot.productId, l.productId), sql`${stockLot.qty} - ${stockLot.reservedQty} > 0`))
      .orderBy(stockLot.expiresAt, stockLot.createdAt)
      .limit(1)
      .for('update');
    const take = lot ? Math.min(l.grams, lot.qty - lot.reservedQty) : 0;
    if (lot && take > 0) await tx.update(stockLot).set({ qty: sql`${stockLot.qty} - ${take}` }).where(eq(stockLot.id, lot.id));
    await tx.insert(stockMove).values({ storeId, productId: l.productId, lotId: take > 0 ? lot!.id : null, type: 'write_off', qty: l.grams, refType: 'order', refId: orderId, reason, actorId });
  }
  await checkStockLevel(tx, storeId, lines.filter((l) => l.grams > 0).map((l) => l.productId));
}

/**
 * Возврат пакета на точку после неявки (ТЗ §11): собранный товар — обратно на склад новой партией без ячейки
 * (кладовщик разместит), охлаждённое и замороженное — в списание.
 */
export async function returnPickedItems(tx: Tx, storeId: string, orderId: string, actorId: string) {
  const picked = await tx
    .select({ itemId: orderItem.id, productId: orderItem.productId, qty: orderItem.qtyPicked, tempZone: product.tempZone })
    .from(orderItem)
    .innerJoin(product, eq(product.id, orderItem.productId))
    .where(and(eq(orderItem.orderId, orderId), eq(orderItem.status, 'picked')));
  for (const it of picked) {
    if (it.qty <= 0) continue;
    if (it.tempZone === 'ambient') {
      const [lot] = await tx.insert(stockLot).values({ storeId, productId: it.productId, qty: it.qty }).returning();
      await tx.insert(stockMove).values({ storeId, productId: it.productId, lotId: lot!.id, type: 'return', qty: it.qty, refType: 'order', refId: orderId, actorId, reason: 'возврат после неявки' });
    } else {
      await tx.insert(stockMove).values({ storeId, productId: it.productId, lotId: null, type: 'write_off', qty: it.qty, refType: 'order', refId: orderId, actorId, reason: `возврат после неявки: ${it.tempZone}` });
    }
  }
}

/** Излишек при инвентаризации: новая партия в ячейке, движение adjust (не приёмка — поставки не было). */
export async function surplusLot(tx: Tx, p: { storeId: string; productId: string; cellId: string; qty: number; reason: string; actorId: string }) {
  const [lot] = await tx.insert(stockLot).values({ storeId: p.storeId, productId: p.productId, cellId: p.cellId, qty: p.qty }).returning();
  await tx.insert(stockMove).values({ storeId: p.storeId, productId: p.productId, lotId: lot!.id, type: 'adjust', qty: p.qty, reason: p.reason, actorId: p.actorId });
  return lot!;
}

/**
 * Мало или нет на складе (ТЗ §10: stock.low, stock.out): после движения, уменьшившего доступный остаток.
 * Доступно = остаток − резерв. Одно событие на товар и уровень в час — без шума при каждой сборке.
 */
export async function checkStockLevel(tx: Tx, storeId: string, productIds: string[]) {
  if (productIds.length === 0) return;
  const P = await loadParams(tx, storeId);
  const rows = await tx
    .select({
      productId: product.id,
      name: product.nameRu,
      weighted: product.isWeighted,
      available: sql<number>`coalesce((select sum(${stockLot.qty} - ${stockLot.reservedQty}) from ${stockLot}
        where ${stockLot.productId} = ${ref(product.id)} and ${stockLot.storeId} = ${storeId}), 0)::int`,
    })
    .from(product)
    .where(inArray(product.id, [...new Set(productIds)]));
  for (const r of rows) {
    const threshold = r.weighted ? P.LOW_STOCK_GRAMS : P.LOW_STOCK_UNITS;
    const topic = r.available <= 0 ? 'stock.out' : r.available < threshold ? 'stock.low' : null;
    if (!topic) continue;
    const recent = await tx.execute<{ n: number }>(sql`
      select count(*)::int n from outbox where topic = ${topic} and aggregate_id = ${r.productId}
        and payload->>'store_id' = ${storeId} and created_at > now() - interval '1 hour'`);
    if ((recent.rows[0]?.n ?? 0) > 0) continue;
    await publish(tx, { topic, aggregateType: 'product', aggregateId: r.productId, payload: { store_id: storeId, name: r.name, available: r.available, unit: r.weighted ? 'г' : 'шт', threshold } });
  }
}
