import { describe, expect, it } from 'vitest';
import { applyPromo, type PromoRule } from './index.js';

const base: PromoRule = {
  id: 'p',
  code: 'NEW',
  brand: null,
  type: 'free_delivery',
  value: 0,
  audience: 'new',
  perCustomerLimit: 1,
  budgetDirams: 100_000,
  spentDirams: 0,
  validFrom: null,
  validTo: null,
};
const ctx = { brand: 'LAB' as const, itemsTotal: 10_000, deliveryFee: 1_500, now: new Date(), customerIsNew: true, customerUses: 0, addressNewcomerUses: 0 };

describe('промо (ТЗ §2, §11)', () => {
  it('бесплатная доставка новичку', () => expect(applyPromo(base, ctx)).toEqual({ discount: 1500 }));
  it('не новичок', () => expect(applyPromo(base, { ...ctx, customerIsNew: false })).toHaveProperty('error'));
  it('третий новичок на адрес', () => expect(applyPromo(base, { ...ctx, addressNewcomerUses: 2 })).toHaveProperty('error'));
  it('процент', () => expect(applyPromo({ ...base, type: 'percent', value: 15, audience: 'all' }, ctx)).toEqual({ discount: 1500 }));
  it('фиксированная не больше суммы', () =>
    expect(applyPromo({ ...base, type: 'fixed', value: 50_000, audience: 'all' }, ctx)).toEqual({ discount: 11_500 }));
  it('бюджет исчерпан', () => expect(applyPromo({ ...base, spentDirams: 99_000 }, ctx)).toHaveProperty('error'));
  it('чужой бренд', () => expect(applyPromo({ ...base, brand: 'SOR' }, ctx)).toHaveProperty('error'));
});
