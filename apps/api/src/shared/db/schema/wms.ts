import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { base, ts } from './_common.js';
import { stockMoveTypeEnum, tempZoneEnum } from './enums.js';
import { product, store } from './refs.js';

/** Ячейка: стеллаж-секция-полка, например A-03-2. */
export const cell = pgTable(
  'cell',
  {
    ...base,
    storeId: uuid('store_id').notNull().references(() => store.id),
    code: text('code').notNull(),
    tempZone: tempZoneEnum('temp_zone').notNull().default('ambient'),
    isCameraCovered: boolean('is_camera_covered').notNull().default(false),
    pickSeq: integer('pick_seq').notNull(),
    capacityUnits: integer('capacity_units').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('cell_store_code_uq').on(t.storeId, t.code)],
);

export const supply = pgTable('supply', {
  ...base,
  storeId: uuid('store_id').notNull().references(() => store.id),
  supplier: text('supplier').notNull(),
  status: text('status').notNull().default('expected'),
  expectedAt: ts('expected_at'),
});

export const supplyItem = pgTable('supply_item', {
  ...base,
  supplyId: uuid('supply_id').notNull().references(() => supply.id),
  productId: uuid('product_id').notNull().references(() => product.id),
  qtyExpected: integer('qty_expected').notNull(),
  qtyReceived: integer('qty_received').notNull().default(0),
  expiresAt: ts('expires_at'),
});

/** Партия в ячейке. Инвариант: qty >= reserved_qty >= 0 (CHECK в миграции). */
export const stockLot = pgTable(
  'stock_lot',
  {
    ...base,
    storeId: uuid('store_id').notNull().references(() => store.id),
    productId: uuid('product_id').notNull().references(() => product.id),
    cellId: uuid('cell_id').references(() => cell.id),
    qty: integer('qty').notNull().default(0),
    reservedQty: integer('reserved_qty').notNull().default(0),
    expiresAt: ts('expires_at'),
    supplyId: uuid('supply_id').references(() => supply.id),
  },
  (t) => [index('stock_lot_store_product_idx').on(t.storeId, t.productId), index('stock_lot_cell_idx').on(t.cellId)],
);

/** Остаток = сумма движений. Прямое изменение qty без движения запрещено (ТЗ §2). */
export const stockMove = pgTable(
  'stock_move',
  {
    ...base,
    storeId: uuid('store_id').notNull().references(() => store.id),
    productId: uuid('product_id').notNull().references(() => product.id),
    lotId: uuid('lot_id').references(() => stockLot.id),
    type: stockMoveTypeEnum('type').notNull(),
    qty: integer('qty').notNull(),
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    actorId: text('actor_id'),
    reason: text('reason'),
  },
  (t) => [index('stock_move_lot_idx').on(t.lotId), index('stock_move_ref_idx').on(t.refType, t.refId)],
);

export const stocktake = pgTable('stocktake', {
  ...base,
  storeId: uuid('store_id').notNull().references(() => store.id),
  scope: text('scope').notNull(),
  status: text('status').notNull().default('open'),
});

export const stocktakeLine = pgTable('stocktake_line', {
  ...base,
  stocktakeId: uuid('stocktake_id').notNull().references(() => stocktake.id),
  cellId: uuid('cell_id').notNull().references(() => cell.id),
  productId: uuid('product_id').notNull().references(() => product.id),
  qtySystem: integer('qty_system').notNull(),
  qtyFact: integer('qty_fact'),
  countedBy: text('counted_by'),
  recountRequired: boolean('recount_required').notNull().default(false),
});
