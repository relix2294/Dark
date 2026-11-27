import { describe, expect, it } from 'vitest';
import { priceCart } from './pricing.js';
import type { PricedProduct } from '../catalog/index.js';

const p = (id: string, price: number, available: number, isWeighted = false): PricedProduct => ({
  id,
  nameRu: id,
  isWeighted,
  isActive: true,
  tempZone: 'ambient',
  priceDirams: price,
  available,
  modifiersRaw: null,
});

describe('пересчёт корзины', () => {
  it('суммы, недоступные позиции, скидка', () => {
    const products = new Map([
      ['a', p('a', 1000, 10)],
      ['b', p('b', 500, 1)],
    ]);
    const r = priceCart([{ product_id: 'a', qty: 2 }, { product_id: 'b', qty: 2 }, { product_id: 'zzz', qty: 1 }], products, 1500, 300, { applied: 'X', error: null });
    expect(r.items_total_dirams).toBe(2000);
    expect(r.unavailable_product_ids).toEqual(['b', 'zzz']);
    expect(r.total_dirams).toBe(2000 + 1500 - 300);
  });
  it('весовой товар — граммы × цена за кг', () => {
    const r = priceCart([{ product_id: 'w', qty: 1500 }], new Map([['w', p('w', 4000, 5000, true)]]), 0, 0, { applied: null, error: null });
    expect(r.items_total_dirams).toBe(6000);
  });
});
