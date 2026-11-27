import type { CartResponse, ModifierSelection } from '@dark/contracts';
import { AppError } from '../../shared/errors/index.js';
import { applyModifiers, parseDishModifiers } from './modifiers.js';
import { lineTotal, orderTotal, sum, type Dirams } from '../../shared/money.js';
import type { PricedProduct } from '../catalog/index.js';

export type CartInputLine = { product_id: string; qty: number; modifiers?: ModifierSelection | undefined };

/**
 * Пересчёт корзины — чистая функция (ТЗ §4 PUT /cart). Недоступные позиции не входят в сумму.
 * Для весового товара qty — граммы.
 */
export function priceCart(
  lines: CartInputLine[],
  products: Map<string, PricedProduct>,
  deliveryFee: Dirams,
  discount: Dirams,
  promo: { applied: string | null; error: string | null },
): CartResponse {
  const out: CartResponse['lines'] = [];
  const unavailable: string[] = [];
  for (const l of lines) {
    const p = products.get(l.product_id);
    if (!p || !p.isActive) {
      unavailable.push(l.product_id);
      out.push({ product_id: l.product_id, name: p?.nameRu ?? '—', qty: l.qty, price_dirams: p?.priceDirams ?? 0, modifiers: [], line_total_dirams: 0, available: false });
      continue;
    }
    // модификаторы: проверка выбора и доплата к цене единицы (цена с клиента не принимается)
    const mod = applyModifiers(parseDishModifiers(p.modifiersRaw), l.modifiers);
    if ('error' in mod) throw new AppError('VALIDATION', `${p.nameRu}: ${mod.error}`, { product_id: p.id });
    const unit = p.priceDirams + mod.extra;
    const available = p.available >= l.qty;
    if (!available) unavailable.push(l.product_id);
    out.push({
      product_id: p.id,
      name: p.nameRu,
      qty: l.qty,
      price_dirams: unit,
      modifiers: mod.snapshot,
      line_total_dirams: available ? lineTotal(unit, l.qty, p.isWeighted) : 0,
      available,
    });
  }
  const itemsTotal = sum(out.map((l) => l.line_total_dirams));
  const safeDiscount = Math.min(discount, itemsTotal + deliveryFee);
  return {
    lines: out,
    unavailable_product_ids: unavailable,
    items_total_dirams: itemsTotal,
    delivery_fee_dirams: deliveryFee,
    discount_dirams: safeDiscount,
    total_dirams: orderTotal(itemsTotal, deliveryFee, safeDiscount),
    promo_applied: promo.applied,
    promo_error: promo.error,
  };
}
