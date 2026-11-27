import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/client.js';
import { order, orderItem, product } from '../../shared/db/schema/index.js';
import { lineTotal, sum } from '../../shared/money.js';
import { publish } from '../../shared/events/outbox.js';
import { AppError } from '../../shared/errors/index.js';

/** Операции с позициями заказа при сборке (ТЗ §7). Вызываются из wms, пишут только таблицы orders. */

export async function getItemsWithProducts(tx: Tx, orderId: string) {
  return tx
    .select({ item: orderItem, product })
    .from(orderItem)
    .innerJoin(product, eq(product.id, orderItem.productId))
    .where(eq(orderItem.orderId, orderId))
    .orderBy(orderItem.createdAt);
}

export async function markItemPicked(tx: Tx, itemId: string, qty: number, weighted: boolean) {
  const [it] = await tx.select().from(orderItem).where(eq(orderItem.id, itemId)).for('update');
  if (!it) throw new AppError('NOT_FOUND', 'Позиция не найдена');
  if (it.status !== 'pending') throw new AppError('INVALID_TRANSITION', `Позиция уже ${it.status}`);
  const picked = weighted ? qty : it.qtyPicked + qty;
  const done = weighted || picked >= it.qtyOrdered;
  await tx.update(orderItem).set({ qtyPicked: picked, ...(done ? { status: 'picked' } : {}) }).where(eq(orderItem.id, itemId));
  return { picked, done };
}

export async function markItemMissing(tx: Tx, itemId: string, meta: Record<string, unknown>) {
  await tx.update(orderItem).set({ status: 'missing', missingMeta: meta }).where(eq(orderItem.id, itemId));
}

export async function addReplacementItem(
  tx: Tx,
  original: typeof orderItem.$inferSelect,
  replacement: { id: string; nameRu: string; priceDirams: number },
  meta: Record<string, unknown>,
) {
  const [ni] = await tx
    .insert(orderItem)
    .values({
      orderId: original.orderId,
      productId: replacement.id,
      nameSnapshot: replacement.nameRu,
      qtyOrdered: original.qtyOrdered,
      priceDirams: replacement.priceDirams,
      replacePolicy: original.replacePolicy,
      status: 'pending',
    })
    .returning();
  await tx.update(orderItem).set({ status: 'replaced', replacedByItemId: ni!.id, missingMeta: meta }).where(eq(orderItem.id, original.id));
  await publish(tx, {
    topic: 'order.item_replaced',
    aggregateType: 'order',
    aggregateId: original.orderId,
    payload: { from: original.productId, to: replacement.id, qty: original.qtyOrdered },
  });
  return ni!;
}

/** Пересчёт сумм после недобора/замены/взвешивания. Инвариант total = items + fee − discount держит БД. */
export async function recalcTotals(tx: Tx, orderId: string) {
  const rows = await getItemsWithProducts(tx, orderId);
  const itemsTotal = sum(
    rows.map(({ item, product: p }) => {
      if (item.status === 'missing' || item.status === 'replaced') return 0;
      const qty = item.status === 'picked' ? item.qtyPicked : item.qtyOrdered;
      return lineTotal(item.priceDirams, qty, p.isWeighted);
    }),
  );
  const [o] = await tx.select().from(order).where(eq(order.id, orderId));
  if (!o) throw new AppError('NOT_FOUND', 'Заказ не найден');
  const discount = Math.min(o.discountDirams, itemsTotal + o.deliveryFeeDirams);
  await tx
    .update(order)
    .set({ itemsTotalDirams: itemsTotal, discountDirams: discount, totalDirams: itemsTotal + o.deliveryFeeDirams - discount })
    .where(eq(order.id, orderId));
  return { itemsTotal, total: itemsTotal + o.deliveryFeeDirams - discount };
}

export async function pendingItemIds(tx: Tx, orderId: string) {
  const rows = await tx.select({ id: orderItem.id }).from(orderItem).where(and(eq(orderItem.orderId, orderId), inArray(orderItem.status, ['pending'])));
  return rows.map((r) => r.id);
}

/** Итог списания по заказу (доставлен, неявка, отмена с удержанием) и причина отмены. */
export async function setCaptured(tx: Tx, orderId: string, amount: number, cancelReason?: string) {
  await tx.update(order).set({ capturedDirams: amount, ...(cancelReason ? { cancelReason } : {}) }).where(eq(order.id, orderId));
}

/** Обещание клиенту, посчитанное кухней (ТЗ §8). */
export async function setPromisedAt(tx: Tx, orderId: string, promisedAt: Date) {
  await tx.update(order).set({ promisedAt }).where(eq(order.id, orderId));
}

/** Заказ кухни упакован: все позиции считаются собранными в заказанном количестве. */
export async function markAllItemsPicked(tx: Tx, orderId: string) {
  await tx.update(orderItem).set({ status: 'picked', qtyPicked: sql`${orderItem.qtyOrdered}` }).where(eq(orderItem.orderId, orderId));
}
