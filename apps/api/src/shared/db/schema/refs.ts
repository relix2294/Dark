import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { base, ts } from './_common.js';
import { brandEnum, staffRoleEnum, stationEnum, tempZoneEnum } from './enums.js';

/** Точка (дарк-стор / кухня). brands — какие бренды обслуживает. */
export const store = pgTable('store', {
  ...base,
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  address: text('address').notNull(),
  brands: text('brands').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  /** JSON по дням недели: {"mon": {"open": "08:00", "close": "23:00"}, ...} */
  workHours: jsonb('work_hours').$type<WorkHours>().notNull(),
});
export type WorkHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { open: string; close: string }>>;

/** Зона доставки — полигон GeoJSON (lon, lat). Проверка точки — в коде, PostGIS не требуется на 4 точки. */
export const deliveryZone = pgTable(
  'delivery_zone',
  {
    ...base,
    storeId: uuid('store_id').notNull().references(() => store.id),
    brand: brandEnum('brand').notNull(),
    polygon: jsonb('polygon').$type<[number, number][]>().notNull(),
    feeDirams: integer('fee_dirams').notNull(),
    minOrderDirams: integer('min_order_dirams').notNull(),
    etaMin: integer('eta_min').notNull(),
    etaMax: integer('eta_max').notNull(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('delivery_zone_store_brand_idx').on(t.storeId, t.brand)],
);

export const category = pgTable('category', {
  ...base,
  brand: brandEnum('brand').notNull(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  parentId: uuid('parent_id'),
});

export const product = pgTable(
  'product',
  {
    ...base,
    brand: brandEnum('brand').notNull(),
    sku: text('sku').notNull(),
    nameRu: text('name_ru').notNull(),
    nameTj: text('name_tj'),
    categoryId: uuid('category_id').references(() => category.id),
    barcodes: text('barcodes').array().notNull().default([]),
    unit: text('unit').notNull().default('шт'),
    weightG: integer('weight_g'),
    isWeighted: boolean('is_weighted').notNull().default(false),
    tempZone: tempZoneEnum('temp_zone').notNull().default('ambient'),
    isHighValue: boolean('is_high_value').notNull().default(false),
    isAgeRestricted: boolean('is_age_restricted').notNull().default(false),
    shelfLifeDays: integer('shelf_life_days'),
    photoUrl: text('photo_url'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('product_brand_sku_uq').on(t.brand, t.sku), index('product_barcodes_idx').using('gin', t.barcodes)],
);

export const price = pgTable(
  'price',
  {
    ...base,
    productId: uuid('product_id').notNull().references(() => product.id),
    storeId: uuid('store_id').notNull().references(() => store.id),
    priceDirams: integer('price_dirams').notNull(),
    oldPriceDirams: integer('old_price_dirams'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
  },
  (t) => [index('price_lookup_idx').on(t.productId, t.storeId, t.validFrom)],
);

/** Блюдо Sor Box — расширение product. */
export const dish = pgTable('dish', {
  ...base,
  productId: uuid('product_id').notNull().unique().references(() => product.id),
  station: stationEnum('station').notNull(),
  cookTimeSec: integer('cook_time_sec').notNull(),
  modifiers: jsonb('modifiers').$type<unknown>().notNull().default({}),
  /** [{product_id, grams}] — рецептура для списания при ready */
  recipe: jsonb('recipe').$type<{ product_id: string; grams: number }[]>().notNull().default([]),
});

export const userStaff = pgTable('user_staff', {
  ...base,
  phone: text('phone').notNull().unique(),
  name: text('name').notNull(),
  role: staffRoleEnum('role').notNull(),
  storeId: uuid('store_id').references(() => store.id),
  pinHash: text('pin_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const customer = pgTable('customer', {
  ...base,
  dcUserId: text('dc_user_id').notNull().unique(),
  phoneMasked: text('phone_masked'),
  name: text('name'),
  firstOrderAt: ts('first_order_at'),
  ordersCount: integer('orders_count').notNull().default(0),
});

export const address = pgTable('address', {
  ...base,
  customerId: uuid('customer_id').notNull().references(() => customer.id),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  street: text('street').notNull(),
  house: text('house').notNull(),
  entrance: text('entrance'),
  floor: text('floor'),
  flat: text('flat'),
  comment: text('comment'),
});

/** Неудачные попытки входа: ключ phone:<телефон> или ip:<адрес>. Защита PIN от перебора. */
export const authAttempt = pgTable('auth_attempt', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: ts('window_start').notNull().defaultNow(),
  lockedUntil: ts('locked_until'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
