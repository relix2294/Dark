import { describe, expect, it } from 'vitest';
import { isSimilar, rejectCell, suggestCells, type CellCandidate, type ProductToPlace } from './placement.js';

const cell = (over: Partial<CellCandidate> & { id: string; pickSeq: number }): CellCandidate => ({
  code: over.id,
  tempZone: 'ambient',
  isCameraCovered: false,
  capacityUnits: 100,
  usedUnits: 0,
  sameCategoryNames: [],
  ...over,
});
const product = (over: Partial<ProductToPlace> = {}): ProductToPlace => ({
  id: 'p',
  nameRu: 'Вафли шоколадные',
  categoryId: 'c',
  tempZone: 'ambient',
  isHighValue: false,
  isFastMover: false,
  qty: 10,
  ...over,
});

describe('размещение (ТЗ §7)', () => {
  it('похожие названия', () => {
    expect(isSimilar('Вафли шоколадные', 'Вафли ванильные')).toBe(true);
    expect(isSimilar('Ручки синие', 'Вафли')).toBe(false);
  });
  it('температурная зона и камера', () => {
    expect(rejectCell(cell({ id: 'a', pickSeq: 1, tempZone: 'chill' }), [], product())).toBe('temp_zone');
    expect(rejectCell(cell({ id: 'a', pickSeq: 1 }), [], product({ isHighValue: true }))).toBe('needs_camera');
    expect(rejectCell(cell({ id: 'a', pickSeq: 1, isCameraCovered: true }), [], product({ isHighValue: true }))).toBeNull();
  });
  it('запрет похожего соседа в ячейке и двух соседних', () => {
    const neighbor = cell({ id: 'b', pickSeq: 2, sameCategoryNames: ['Вафли ванильные'] });
    expect(rejectCell(cell({ id: 'a', pickSeq: 1 }), [neighbor], product())).toBe('similar_neighbor');
  });
  it('ходовой — к меньшему pick_seq; обычный — к большему свободному месту', () => {
    const cells = [cell({ id: 'far', pickSeq: 9, usedUnits: 0 }), cell({ id: 'near', pickSeq: 1, usedUnits: 50 })];
    expect(suggestCells(cells, product({ isFastMover: true }))[0]?.id).toBe('near');
    expect(suggestCells(cells, product())[0]?.id).toBe('far');
  });
  it('нет места', () => expect(rejectCell(cell({ id: 'a', pickSeq: 1, usedUnits: 95 }), [], product())).toBe('no_space'));
});
