import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { CatalogQuery, CatalogResponse, ResolveStoreQuery, ResolveStoreResponse, type Brand } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { deliveryZone, price, product, stockLot, store } from '../../shared/db/schema/index.js';
import { AppError } from '../../shared/errors/index.js';
import { pointInPolygon } from '../../shared/geo.js';
import { isOpenAt } from './hours.js';

export { isOpenAt } from './hours.js';

/** Публичный интерфейс модуля catalog для orders/cart. */
export type PricedProduct = {
  id: string;
  nameRu: string;
  isWeighted: boolean;
  isActive: boolean;
  tempZone: 'ambient' | 'chill' | 'frozen';
  priceDirams: number;
  available: number; // доступно к резерву
};

export async function getStore(deps: AppDeps, storeId: string) {
  const [s] = await deps.db.select().from(store).where(eq(store.id, storeId));
  if (!s) throw new AppError('NOT_FOUND', 'Точка не найдена', { store_id: storeId });
  return s;
}

export async function resolveZone(deps: AppDeps, brand: Brand, geo: { lat: number; lon: number }) {
  const zones = await deps.db
    .select({ zone: deliveryZone, store })
    .from(deliveryZone)
    .innerJoin(store, eq(store.id, deliveryZone.storeId))
    .where(and(eq(deliveryZone.brand, brand), eq(deliveryZone.isActive, true), eq(store.isActive, true)));
  const hit = zones.find(({ zone }) => pointInPolygon(geo, zone.polygon));
  if (!hit) throw new AppError('OUT_OF_ZONE', 'Адрес вне зоны доставки');
  return hit;
}

/** Товары с актуальной ценой на точке и доступным остатком (одним запросом по списку id). */
export async function priceProducts(deps: AppDeps, storeId: string, productIds: string[]): Promise<Map<string, PricedProduct>> {
  if (productIds.length === 0) return new Map();
  const now = deps.clock.now();
  const rows = await deps.db
    .select({
      id: product.id,
      nameRu: product.nameRu,
      isWeighted: product.isWeighted,
      isActive: product.isActive,
      tempZone: product.tempZone,
      priceDirams: price.priceDirams,
      available: sql<number>`coalesce((select sum(${stockLot.qty} - ${stockLot.reservedQty}) from ${stockLot}
        where ${stockLot.productId} = ${product.id} and ${stockLot.storeId} = ${storeId}), 0)::int`,
    })
    .from(product)
    .innerJoin(
      price,
      and(
        eq(price.productId, product.id),
        eq(price.storeId, storeId),
        lte(price.validFrom, now),
        or(isNull(price.validTo), gt(price.validTo, now)),
      ),
    )
    .where(inArray(product.id, productIds));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function registerCatalog(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/stores/resolve',
    { schema: { tags: ['storefront'], querystring: ResolveStoreQuery, response: { 200: ResolveStoreResponse } } },
    async (req) => {
      const { zone, store: s } = await resolveZone(deps, req.query.brand, req.query);
      return {
        store_id: s.id,
        zone_id: zone.id,
        fee_dirams: zone.feeDirams,
        min_order_dirams: zone.minOrderDirams,
        eta_min: zone.etaMin,
        eta_max: zone.etaMax,
        is_open: isOpenAt(s.workHours, deps.clock.now(), deps.config.DISPLAY_TZ),
      };
    },
  );

  r.get('/catalog', { schema: { tags: ['storefront'], querystring: CatalogQuery, response: { 200: CatalogResponse } } }, async (req) => {
    const { store_id, brand, category, q } = req.query;
    const now = deps.clock.now();
    const rows = await deps.db
      .select({
        product,
        priceDirams: price.priceDirams,
        oldPriceDirams: price.oldPriceDirams,
        available: sql<number>`coalesce((select sum(${stockLot.qty} - ${stockLot.reservedQty}) from ${stockLot}
          where ${stockLot.productId} = ${product.id} and ${stockLot.storeId} = ${store_id}), 0)::int`,
      })
      .from(product)
      .innerJoin(
        price,
        and(eq(price.productId, product.id), eq(price.storeId, store_id), lte(price.validFrom, now), or(isNull(price.validTo), gt(price.validTo, now))),
      )
      .where(
        and(
          eq(product.brand, brand),
          eq(product.isActive, true),
          category ? eq(product.categoryId, category) : undefined,
          q ? sql`${product.nameRu} ilike ${'%' + q + '%'}` : undefined,
        ),
      )
      .limit(500);
    return {
      items: rows.map((r) => ({
        product_id: r.product.id,
        sku: r.product.sku,
        name_ru: r.product.nameRu,
        name_tj: r.product.nameTj,
        category_id: r.product.categoryId,
        unit: r.product.unit,
        is_weighted: r.product.isWeighted,
        temp_zone: r.product.tempZone,
        price_dirams: r.priceDirams,
        old_price_dirams: r.oldPriceDirams,
        // остаток числом не отдаётся — только признак (ТЗ §4); для SOR наличие определяет стоп-лист (этап 1: всегда true)
        in_stock: brand === 'SOR' ? true : r.available > 0,
        photo_url: r.product.photoUrl,
      })),
    };
  });
}
