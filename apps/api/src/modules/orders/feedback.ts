import { and, eq } from 'drizzle-orm';
import type { CustomerPrincipal, DishModifiers, ModifierSelection, ModifierSnapshot, RatingTag, ReplacePolicy } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { order, orderItem, orderRating } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { priceProducts } from '../catalog/index.js';
import { applyModifiers, parseDishModifiers } from './modifiers.js';

/** Оценку можно поставить в течение недели после доставки. */
const RATE_WINDOW_MS = 7 * 24 * 3600_000;

/** Оценка доставленного заказа (ТЗ §9 «Доставлен»: оценка). Одна на заказ; низкая (≤ 3) — тревога на пульт. */
export async function rateOrder(deps: AppDeps, me: CustomerPrincipal, orderId: string, input: { score: number; tags: RatingTag[]; comment?: string | undefined }) {
  return deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(order).where(and(eq(order.id, orderId), eq(order.customerId, me.customer_id))).for('update');
    if (!o) throw notFound('Заказ', orderId);
    if (o.status !== 'delivered') throw new AppError('INVALID_TRANSITION', 'Оценить можно только доставленный заказ');
    if (o.deliveredAt && deps.clock.now().getTime() - o.deliveredAt.getTime() > RATE_WINDOW_MS) throw new AppError('INVALID_TRANSITION', 'Срок оценки заказа истёк');
    const [r] = await tx
      .insert(orderRating)
      .values({ orderId: o.id, customerId: me.customer_id, storeId: o.storeId, score: input.score, tags: [...new Set(input.tags)], comment: input.comment || null })
      .onConflictDoNothing({ target: orderRating.orderId })
      .returning();
    if (!r) throw new AppError('INVALID_TRANSITION', 'Заказ уже оценён');
    await publish(tx, { topic: 'order.rated', aggregateType: 'order', aggregateId: o.id, payload: { store_id: o.storeId, score: r.score, tags: r.tags, comment: r.comment } });
    return ratingView(r);
  });
}

export const ratingView = (r: typeof orderRating.$inferSelect) => ({ score: r.score, tags: r.tags, comment: r.comment, created_at: r.createdAt.toISOString() });

export async function getRating(deps: AppDeps, orderId: string) {
  const [r] = await deps.db.select().from(orderRating).where(eq(orderRating.orderId, orderId));
  return r ? ratingView(r) : null;
}

/** Снимок модификаторов (названия) → выбор по текущему меню (id). null — варианта больше нет. */
export function selectionFromSnapshot(def: DishModifiers, snap: ModifierSnapshot): ModifierSelection | null {
  const sel: ModifierSelection = {};
  for (const g of snap) {
    const group = def.groups.find((x) => x.name === g.group);
    if (!group) return null;
    for (const o of g.options) {
      const opt = group.options.find((x) => x.name === o.name);
      if (!opt) return null;
      (sel[group.id] ??= []).push(opt.id);
    }
  }
  return sel;
}

/**
 * «Повторить заказ» (ТЗ §9): исходные позиции (без замен, выбранных сборщиком) по текущему меню и ценам.
 * Снятое с продажи и блюда с изменившимися вариантами — в skipped с причиной; наличие проверит PUT /cart.
 */
export async function repeatOrder(deps: AppDeps, me: CustomerPrincipal, orderId: string) {
  const [o] = await deps.db.select().from(order).where(and(eq(order.id, orderId), eq(order.customerId, me.customer_id)));
  if (!o) throw notFound('Заказ', orderId);
  const items = await deps.db.select().from(orderItem).where(eq(orderItem.orderId, o.id)).orderBy(orderItem.createdAt);
  const replacements = new Set(items.map((i) => i.replacedByItemId).filter((x): x is string => !!x));
  const originals = items.filter((i) => !replacements.has(i.id));
  const priced = await priceProducts(deps, o.storeId, [...new Set(originals.map((i) => i.productId))]);

  const merged = new Map<string, { product_id: string; qty: number; replace_policy: ReplacePolicy; modifiers?: ModifierSelection }>();
  const skipped: { product_id: string; name: string; reason: string }[] = [];
  for (const i of originals) {
    const p = priced.get(i.productId);
    if (!p || !p.isActive) {
      skipped.push({ product_id: i.productId, name: i.nameSnapshot, reason: 'больше не продаётся' });
      continue;
    }
    const def = parseDishModifiers(p.modifiersRaw);
    const sel = selectionFromSnapshot(def, i.modifiers ?? []);
    if (!sel || 'error' in applyModifiers(def, sel)) {
      skipped.push({ product_id: i.productId, name: i.nameSnapshot, reason: 'изменились варианты — выберите заново' });
      continue;
    }
    const hasMods = Object.keys(sel).length > 0;
    const key = `${i.productId}|${JSON.stringify(sel)}`;
    const prev = merged.get(key);
    if (prev) prev.qty += i.qtyOrdered;
    else merged.set(key, { product_id: i.productId, qty: i.qtyOrdered, replace_policy: i.replacePolicy, ...(hasMods ? { modifiers: sel } : {}) });
  }
  return { brand: o.brand, store_id: o.storeId, items: [...merged.values()], skipped };
}
