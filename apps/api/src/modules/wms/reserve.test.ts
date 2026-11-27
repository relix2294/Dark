import { describe, expect, it } from 'vitest';
import { isSellable, planReserve, type Lot } from './reserve.js';

const now = new Date('2026-11-27T00:00:00Z');
const day = 86_400_000;
const lot = (id: string, qty: number, expiresInDays: number | null, reserved = 0): Lot => ({
  id,
  qty,
  reservedQty: reserved,
  expiresAt: expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * day),
  receivedAt: new Date(now.getTime() - 10 * day),
  shelfLifeDays: 30,
});

describe('резерв FEFO (ТЗ §7)', () => {
  it('ближайший срок — первым, остаток добирается из следующей партии', () => {
    const r = planReserve([lot('late', 10, 25), lot('soon', 3, 15)], 5, now, 20);
    expect(r.plan).toEqual([
      { lotId: 'soon', qty: 3 },
      { lotId: 'late', qty: 2 },
    ]);
    expect(r.shortage).toBe(0);
  });
  it('партия с остатком срока < 20 % не резервируется', () => {
    expect(isSellable(lot('x', 1, 5), now, 20)).toBe(false); // 5 из 30 дней = 16 %
    expect(isSellable(lot('x', 1, 7), now, 20)).toBe(true);
    const r = planReserve([lot('old', 10, 5)], 1, now, 20);
    expect(r.shortage).toBe(1);
  });
  it('учитывает уже зарезервированное', () => {
    const r = planReserve([lot('a', 5, 20, 4)], 2, now, 20);
    expect(r.plan).toEqual([{ lotId: 'a', qty: 1 }]);
    expect(r.shortage).toBe(1);
  });
});
