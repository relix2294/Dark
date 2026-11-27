import { and, eq, sql } from 'drizzle-orm';
import type { Brand, PromoType } from '@dark/contracts';
import type { Tx } from '../../shared/db/client.js';
import { promo, promoUse } from '../../shared/db/schema/index.js';
import { percentOf, type Dirams } from '../../shared/money.js';
import { AppError } from '../../shared/errors/index.js';

export type PromoRule = {
  id: string;
  code: string;
  brand: Brand | null;
  type: PromoType;
  value: number;
  audience: 'new' | 'all' | 'segment';
  perCustomerLimit: number;
  budgetDirams: number | null;
  spentDirams: number;
  validFrom: Date | null;
  validTo: Date | null;
};

export type PromoContext = {
  brand: Brand;
  itemsTotal: Dirams;
  deliveryFee: Dirams;
  now: Date;
  customerIsNew: boolean;
  customerUses: number;
  /** Сколько новичков уже использовали промо по этому адресу (ТЗ §11: не больше 2). */
  addressNewcomerUses: number;
};

/** Чистый расчёт скидки. Возвращает сумму скидки или причину отказа. */
export function applyPromo(p: PromoRule, ctx: PromoContext): { discount: Dirams } | { error: string } {
  if (p.brand && p.brand !== ctx.brand) return { error: 'Промокод другого бренда' };
  if (p.validFrom && ctx.now < p.validFrom) return { error: 'Промокод ещё не действует' };
  if (p.validTo && ctx.now > p.validTo) return { error: 'Промокод истёк' };
  if (p.audience === 'new' && !ctx.customerIsNew) return { error: 'Только для новых клиентов' };
  if (p.audience === 'new' && ctx.addressNewcomerUses >= 2) return { error: 'Лимит на адрес исчерпан' };
  if (ctx.customerUses >= p.perCustomerLimit) return { error: 'Промокод уже использован' };
  let discount: Dirams;
  switch (p.type) {
    case 'free_delivery':
      discount = ctx.deliveryFee;
      break;
    case 'percent':
      discount = percentOf(ctx.itemsTotal, p.value);
      break;
    case 'fixed':
      discount = Math.min(p.value, ctx.itemsTotal + ctx.deliveryFee);
      break;
  }
  if (p.budgetDirams !== null && p.spentDirams + discount > p.budgetDirams) return { error: 'Бюджет промо исчерпан' };
  return { discount };
}

export async function findPromo(tx: Tx, code: string): Promise<PromoRule | null> {
  const [p] = await tx.select().from(promo).where(eq(promo.code, code.toUpperCase()));
  return p ?? null;
}

export async function countUses(tx: Tx, promoId: string, customerId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(promoUse)
    .where(and(eq(promoUse.promoId, promoId), eq(promoUse.customerId, customerId)));
  return r?.n ?? 0;
}

/**
 * Фиксация использования с атомарным контролем бюджета (ТЗ §11): UPDATE с условием spent + x <= budget.
 * Если строка не обновилась — бюджет исчерпан, перерасход невозможен.
 */
export async function recordUse(tx: Tx, p: PromoRule, customerId: string, orderId: string, amount: Dirams): Promise<void> {
  const updated = await tx
    .update(promo)
    .set({ spentDirams: sql`${promo.spentDirams} + ${amount}` })
    .where(and(eq(promo.id, p.id), p.budgetDirams === null ? undefined : sql`${promo.spentDirams} + ${amount} <= ${promo.budgetDirams}`))
    .returning({ id: promo.id });
  if (updated.length === 0) throw new AppError('PROMO_NOT_APPLICABLE', 'Бюджет промо исчерпан');
  await tx.insert(promoUse).values({ promoId: p.id, customerId, orderId, amountDirams: amount });
}

export { registerPromoAdmin } from './admin.js';
