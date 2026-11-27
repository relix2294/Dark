import { z } from 'zod';
import { Brand, TempZone } from './enums.js';
import { Dirams } from './money.js';
import { Uuid } from './common.js';

export const ResolveStoreQuery = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  brand: Brand,
});
export const ResolveStoreResponse = z.object({
  store_id: Uuid,
  zone_id: Uuid,
  fee_dirams: Dirams,
  min_order_dirams: Dirams,
  eta_min: z.number().int(),
  eta_max: z.number().int(),
  is_open: z.boolean(),
});

export const CatalogQuery = z.object({
  store_id: Uuid,
  brand: Brand,
  category: Uuid.optional(),
  q: z.string().max(100).optional(),
});

/** Остаток числом клиенту не отдаётся — только признак наличия (ТЗ §4). */
export const CatalogItem = z.object({
  product_id: Uuid,
  sku: z.string(),
  name_ru: z.string(),
  name_tj: z.string().nullable(),
  category_id: Uuid.nullable(),
  unit: z.string(),
  is_weighted: z.boolean(),
  temp_zone: TempZone,
  price_dirams: Dirams,
  old_price_dirams: Dirams.nullable(),
  in_stock: z.boolean(),
  photo_url: z.string().nullable(),
});
export const CatalogResponse = z.object({ items: z.array(CatalogItem) });
