/**
 * Склад Lablabu: ячейки, партии, приёмка, размещение, сборка, инвентаризация (ТЗ §7). Публичный интерфейс: reserve.ts (FEFO), placement.ts. Маршруты /wms/* — следующая итерация.
 * Другие модули импортируют только из этого index.ts.
 */
export { planReserve, isSellable, type Lot, type ReservePlan } from './reserve.js';
export { suggestCells, rejectCell, type CellCandidate, type ProductToPlace } from './placement.js';
