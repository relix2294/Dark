import type { TempZone } from '@dark/contracts';

/**
 * Размещение товара в ячейку (ТЗ §7). Чистая функция: сервис передаёт кандидатов, получает ранжированный список.
 * 1) температурная зона; 2) is_high_value → только камера; 3) запрет соседства похожих;
 * 4) ходовой товар — к меньшему pick_seq; 5) из подходящих — наибольшее свободное место.
 */
export type CellCandidate = {
  id: string;
  code: string;
  tempZone: TempZone;
  isCameraCovered: boolean;
  pickSeq: number;
  capacityUnits: number;
  usedUnits: number;
  /** Нормализованные названия товаров той же категории в этой ячейке. */
  sameCategoryNames: string[];
};

export type ProductToPlace = {
  id: string;
  nameRu: string;
  categoryId: string | null;
  tempZone: TempZone;
  isHighValue: boolean;
  /** Входит в топ-20 % по частоте заказов. */
  isFastMover: boolean;
  qty: number;
};

export type PlacementRejection = 'temp_zone' | 'needs_camera' | 'similar_neighbor' | 'no_space';

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «Похожие названия»: совпадает первое слово или одно название — префикс другого. */
export function isSimilar(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  return na.split(' ')[0] === nb.split(' ')[0];
}

/** Почему ячейка недопустима, либо null если допустима. neighbors — две соседние по pick_seq. */
export function rejectCell(cell: CellCandidate, neighbors: CellCandidate[], p: ProductToPlace): PlacementRejection | null {
  if (cell.tempZone !== p.tempZone) return 'temp_zone';
  if (p.isHighValue && !cell.isCameraCovered) return 'needs_camera';
  if (cell.capacityUnits - cell.usedUnits < p.qty) return 'no_space';
  const around = [cell, ...neighbors];
  if (around.some((c) => c.sameCategoryNames.some((n) => isSimilar(n, p.nameRu)))) return 'similar_neighbor';
  return null;
}

export function neighborsOf(cell: CellCandidate, all: CellCandidate[]): CellCandidate[] {
  return all.filter((c) => c.id !== cell.id && Math.abs(c.pickSeq - cell.pickSeq) === 1);
}

/** Ранжированные допустимые ячейки; первая — предложение системы. */
export function suggestCells(cells: CellCandidate[], p: ProductToPlace): CellCandidate[] {
  const ok = cells.filter((c) => rejectCell(c, neighborsOf(c, cells), p) === null);
  const free = (c: CellCandidate) => c.capacityUnits - c.usedUnits;
  return ok.sort((a, b) => {
    if (p.isFastMover && a.pickSeq !== b.pickSeq) return a.pickSeq - b.pickSeq;
    return free(b) - free(a) || a.pickSeq - b.pickSeq;
  });
}
