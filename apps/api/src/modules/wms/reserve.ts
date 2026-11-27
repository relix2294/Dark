/**
 * Резерв по FEFO (ТЗ §7): партии с ближайшим сроком — первыми; партии с остатком срока
 * меньше MIN_SHELF_LIFE_PCT не резервируются и попадают в список на уценку.
 */
export type Lot = {
  id: string;
  qty: number;
  reservedQty: number;
  expiresAt: Date | null;
  receivedAt: Date;
  shelfLifeDays: number | null;
};

export type ReservePlan = { lotId: string; qty: number }[];

export function isSellable(lot: Lot, now: Date, minShelfLifePct: number): boolean {
  if (!lot.expiresAt) return true;
  if (lot.expiresAt <= now) return false;
  const total = lot.shelfLifeDays ? lot.shelfLifeDays * 86_400_000 : lot.expiresAt.getTime() - lot.receivedAt.getTime();
  if (total <= 0) return true;
  const left = lot.expiresAt.getTime() - now.getTime();
  return (left / total) * 100 >= minShelfLifePct;
}

export function planReserve(lots: Lot[], qty: number, now: Date, minShelfLifePct: number): { plan: ReservePlan; shortage: number } {
  const sorted = lots
    .filter((l) => isSellable(l, now, minShelfLifePct) && l.qty - l.reservedQty > 0)
    .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
  const plan: ReservePlan = [];
  let need = qty;
  for (const l of sorted) {
    if (need === 0) break;
    const take = Math.min(need, l.qty - l.reservedQty);
    plan.push({ lotId: l.id, qty: take });
    need -= take;
  }
  return { plan, shortage: need };
}
