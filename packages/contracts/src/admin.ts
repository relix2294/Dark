import { z } from 'zod';
import { Geo, Uuid } from './common.js';
import { Brand, PromoAudience, PromoType, StaffRole, Station, TempZone, Transport } from './enums.js';
import { Dirams } from './money.js';
import { DishModifiers } from './modifiers.js';

/** Админка (ТЗ §9): каталог, цены, зоны, промо, персонал, склад, график курьеров, отчёты. */

export const IdParams = z.object({ id: Uuid });
export const StoreIdParams = z.object({ store_id: Uuid });
export const StoreChildParams = z.object({ store_id: Uuid, id: Uuid });

// ---------- точки ----------
const HoursDay = z.object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/) });
export const WorkHours = z.partialRecord(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), HoursDay);

export const StoreInput = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(100),
  address: z.string().min(1).max(200),
  geo: Geo,
  brands: z.array(Brand).min(1),
  work_hours: WorkHours,
  is_active: z.boolean().default(true),
});
export const StorePatch = StoreInput.partial();
export const StoreView = StoreInput.extend({ id: Uuid });
export const StoreListView = z.object({ stores: z.array(StoreView) });

// ---------- категории и товары ----------
export const CategoryInput = z.object({ brand: Brand, name: z.string().min(1).max(100), sort: z.number().int().default(0), parent_id: Uuid.nullable().default(null) });
export const CategoryView = CategoryInput.extend({ id: Uuid });
export const CategoryListView = z.object({ categories: z.array(CategoryView) });
export const CategoryQuery = z.object({ brand: Brand.optional() });

export const ProductInput = z.object({
  brand: Brand,
  sku: z.string().min(1).max(40),
  name_ru: z.string().min(1).max(200),
  name_tj: z.string().max(200).nullable().default(null),
  category_id: Uuid.nullable().default(null),
  barcodes: z.array(z.string().min(3).max(40)).default([]),
  unit: z.string().max(10).default('шт'),
  weight_g: z.number().int().min(0).nullable().default(null),
  is_weighted: z.boolean().default(false),
  temp_zone: TempZone.default('ambient'),
  is_high_value: z.boolean().default(false),
  is_age_restricted: z.boolean().default(false),
  shelf_life_days: z.number().int().min(0).nullable().default(null),
  photo_url: z.string().max(500).nullable().default(null),
  is_active: z.boolean().default(true),
});
export const ProductPatch = ProductInput.omit({ brand: true }).partial();

export const PriceView = z.object({ store_id: Uuid, price_dirams: Dirams, old_price_dirams: Dirams.nullable(), valid_from: z.iso.datetime() });
export const DishView = z.object({
  station: Station,
  cook_time_sec: z.number().int().min(1),
  modifiers: DishModifiers,
  recipe: z.array(z.object({ product_id: Uuid, grams: z.number().int().min(1) })),
});
export const ProductView = ProductInput.extend({ id: Uuid, barcodes: z.array(z.string()), prices: z.array(PriceView), dish: DishView.nullable() });
export const ProductListView = z.object({ products: z.array(ProductView), total: z.number().int() });
export const ProductQuery = z.object({
  brand: Brand.optional(),
  q: z.string().max(100).optional(),
  category_id: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Новая цена закрывает предыдущую (valid_to = сейчас) — история цен сохраняется. Пишется в журнал. */
export const PriceInput = z.object({
  store_id: Uuid,
  price_dirams: Dirams.min(1),
  old_price_dirams: Dirams.nullable().default(null),
  reason: z.string().min(1).max(200),
});
export const DishInput = DishView;

// ---------- зоны ----------
export const ZoneInput = z.object({
  brand: Brand,
  /** Полигон [lon, lat][] — как в GeoJSON, минимум 3 точки. */
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3).max(500),
  fee_dirams: Dirams,
  min_order_dirams: Dirams,
  eta_min: z.number().int().min(1),
  eta_max: z.number().int().min(1),
  is_active: z.boolean().default(true),
});
export const ZonePatch = ZoneInput.partial().extend({ reason: z.string().min(1).max(200) });
export const ZoneView = ZoneInput.extend({ id: Uuid, store_id: Uuid });
export const ZoneListView = z.object({ zones: z.array(ZoneView) });

// ---------- промо ----------
export const PromoInput = z.object({
  code: z.string().min(2).max(32).regex(/^[A-Z0-9_-]+$/),
  brand: Brand.nullable().default(null),
  type: PromoType,
  /** percent — проценты; fixed — дирамы; free_delivery — 0. */
  value: z.number().int().min(0),
  audience: PromoAudience.default('all'),
  per_customer_limit: z.number().int().min(1).default(1),
  budget_dirams: Dirams.nullable().default(null),
  valid_from: z.iso.datetime().nullable().default(null),
  valid_to: z.iso.datetime().nullable().default(null),
});
export const PromoPatch = PromoInput.omit({ code: true }).partial().extend({ reason: z.string().min(1).max(200) });
export const PromoView = PromoInput.extend({ id: Uuid, spent_dirams: Dirams, uses: z.number().int() });
export const PromoListView = z.object({ promos: z.array(PromoView) });

// ---------- персонал ----------
export const StaffInput = z.object({
  phone: z.string().regex(/^\+?\d{9,15}$/),
  name: z.string().min(1).max(100),
  role: StaffRole,
  store_id: Uuid.nullable(),
  pin: z.string().regex(/^\d{4,6}$/),
  transport: Transport.optional(),
});
export const StaffPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  role: StaffRole.optional(),
  store_id: Uuid.nullable().optional(),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
  is_active: z.boolean().optional(),
  reason: z.string().min(1).max(200),
});
export const StaffView = z.object({ id: Uuid, phone: z.string(), name: z.string(), role: StaffRole, store_id: Uuid.nullable(), is_active: z.boolean() });
export const StaffListView = z.object({ staff: z.array(StaffView) });
export const StaffQuery = z.object({ store_id: Uuid.optional() });

// ---------- склад ----------
export const CellInput = z.object({
  code: z.string().regex(/^[A-Z]-\d{2}-\d$/),
  temp_zone: TempZone.default('ambient'),
  is_camera_covered: z.boolean().default(false),
  pick_seq: z.number().int().min(0),
  capacity_units: z.number().int().min(1).default(100),
  is_active: z.boolean().default(true),
});
export const CellView = CellInput.extend({ id: Uuid, used_units: z.number().int() });
export const CellListView = z.object({ cells: z.array(CellView) });

export const SupplyInput = z.object({
  supplier: z.string().min(1).max(200),
  expected_at: z.iso.datetime().nullable().default(null),
  items: z.array(z.object({ product_id: Uuid, qty_expected: z.number().int().min(1) })).min(1),
});
export const SupplyListItem = z.object({ id: Uuid, supplier: z.string(), status: z.string(), expected_at: z.iso.datetime().nullable(), lines: z.number().int(), created_at: z.iso.datetime() });
export const SupplyListView = z.object({ supplies: z.array(SupplyListItem) });

export const StockRow = z.object({
  product_id: Uuid,
  name: z.string(),
  sku: z.string(),
  unit: z.string(),
  qty: z.number().int(),
  reserved_qty: z.number().int(),
  unplaced_qty: z.number().int(),
  nearest_expiry: z.iso.datetime().nullable(),
});
export const StockListView = z.object({ rows: z.array(StockRow) });

/** Корректировка остатка после пересчёта — только управляющий (ТЗ §9). */
export const AdjustInput = z.object({ lot_id: Uuid, qty_fact: z.number().int().min(0), reason: z.string().min(1).max(200) });

// ---------- график курьеров ----------
export const CourierPlanQuery = z.object({ date: z.iso.date() });
export const CourierPlanRow = z.object({
  hour: z.number().int().min(0).max(23),
  forecast_orders_lab: z.number().int().min(0),
  forecast_orders_sor: z.number().int().min(0),
  couriers_needed: z.number().int().min(0),
  couriers_planned: z.number().int().min(0),
});
export const CourierPlanView = z.object({ date: z.iso.date(), rows: z.array(CourierPlanRow) });
export const CourierPlanInput = z.object({ rows: z.array(z.object({ hour: z.number().int().min(0).max(23), couriers_planned: z.number().int().min(0) })).min(1) });

// ---------- отчёты ----------
export const ReportQuery = z.object({ store_id: Uuid, from: z.iso.date(), to: z.iso.date() });
export const ReportSummary = z.object({
  orders_total: z.number().int(),
  orders_by_status: z.record(z.string(), z.number().int()),
  by_brand: z.array(z.object({ brand: Brand, orders: z.number().int(), delivered: z.number().int(), captured_dirams: Dirams, avg_check_dirams: Dirams, on_time_pct: z.number() })),
  refunds_dirams: Dirams,
  discounts_dirams: Dirams,
  write_offs: z.number().int(),
  avg_pick_sec: z.number().nullable(),
  pickers: z.array(z.object({ staff_id: Uuid, name: z.string(), tasks: z.number().int(), avg_sec: z.number() })),
  daily: z.array(z.object({ date: z.iso.date(), orders: z.number().int(), captured_dirams: Dirams })),
});
export const MoneyReport = z.object({
  payments_by_status: z.record(z.string(), z.object({ count: z.number().int(), dirams: Dirams })),
  pending_over_5min: z.array(z.object({ payment_id: Uuid, order_id: Uuid, status: z.string(), since: z.iso.datetime(), last_error: z.string().nullable() })),
  failed_ops: z.array(z.object({ payment_id: Uuid, type: z.string(), amount_dirams: Dirams, key: z.string(), at: z.iso.datetime() })),
});

// ---------- импорт каталога ----------
/** Строка импорта (CSV разбирается на клиенте). Ключ — бренд + артикул: есть — обновляем, нет — создаём. */
export const ImportRow = z.object({
  sku: z.string().min(1).max(40),
  name_ru: z.string().min(1).max(200),
  name_tj: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  barcodes: z.array(z.string().min(3).max(40)).default([]),
  unit: z.string().max(10).optional(),
  temp_zone: TempZone.optional(),
  is_weighted: z.boolean().optional(),
  is_high_value: z.boolean().optional(),
  shelf_life_days: z.number().int().min(0).nullable().optional(),
  /** Цена на выбранной точке; пусто — цену не трогаем. */
  price_dirams: Dirams.min(1).optional(),
  is_active: z.boolean().optional(),
});
export const ImportRequest = z.object({
  brand: Brand,
  store_id: Uuid,
  rows: z.array(z.unknown()).min(1).max(5000),
  /** true — только проверить и показать, что изменится. */
  dry_run: z.boolean().default(true),
  reason: z.string().min(1).max(200),
});
export const ImportResult = z.object({
  dry_run: z.boolean(),
  applied: z.boolean(),
  created: z.number().int(),
  updated: z.number().int(),
  prices_changed: z.number().int(),
  categories_created: z.array(z.string()),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
});

// ---------- сроки годности (ТЗ §7) ----------
export const ExpiringRow = z.object({
  lot_id: Uuid,
  product_id: Uuid,
  name: z.string(),
  sku: z.string(),
  cell_code: z.string().nullable(),
  qty: z.number().int(),
  expires_at: z.iso.datetime(),
  left_pct: z.number(),
  /** write_off — истёк; markdown — остаток срока ниже MIN_SHELF_LIFE_PCT (не резервируется) или ≤ 2 дней. */
  action: z.enum(['write_off', 'markdown']),
});
export const ExpiringView = z.object({ rows: z.array(ExpiringRow) });

// ---------- инвентаризация (ТЗ §7) ----------
export const StocktakeCreate = z.object({ scope: z.enum(['cell', 'full']), cell_codes: z.array(z.string()).optional() });
export const StocktakeLineAdmin = z.object({
  id: Uuid,
  cell_code: z.string(),
  product_id: Uuid,
  name: z.string(),
  unit: z.string(),
  qty_system: z.number().int(),
  qty_fact: z.number().int().nullable(),
  recount_required: z.boolean(),
});
export const StocktakeAdminView = z.object({ id: Uuid, scope: z.string(), status: z.string(), created_at: z.iso.datetime(), lines: z.array(StocktakeLineAdmin) });
export const StocktakeListView = z.object({ stocktakes: z.array(StocktakeAdminView) });
export const StocktakeApplyResult = z.object({ adjusted: z.number().int(), unchanged: z.number().int(), not_counted: z.number().int() });
