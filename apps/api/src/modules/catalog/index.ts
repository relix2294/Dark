import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { CatalogQuery, CatalogResponse, ResolveStoreQuery, ResolveStoreResponse, type Brand } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { category as categoryT, deliveryZone, dish, price, product, stockLot, stopList, store } from '../../shared/db/schema/index.js';
import type { Tx } from '../../shared/db/client.js';
import { AppError } from '../../shared/errors/index.js';
import { pointInPolygon } from '../../shared/geo.js';
import { isOpenAt } from './hours.js';
import { DishModifiers } from '@dark/contracts';

export { isOpenAt } from './hours.js';
export { registerCatalogAdmin } from './admin.js';
export { registerCatalogImport } from './import.js';

/** Публичный интерфейс модуля catalog для orders/cart. */
export type PricedProduct = {
  id: string;
  brand: 'LAB' | 'SOR';
  nameRu: string;
  isWeighted: boolean;
  isActive: boolean;
  tempZone: 'ambient' | 'chill' | 'frozen';
  priceDirams: number;
  available: number; // доступно к резерву
  /** Определение модификаторов блюда (сырое из БД — разбирает orders). */
  modifiersRaw: unknown;
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

/** Блюда SOR, недоступные по стоп-листу: само блюдо или любой ингредиент рецептуры (ТЗ §8). */
export async function stoppedProductIds(deps: AppDeps, storeId: string, productIds: string[]): Promise<Set<string>> {
  const stopped = new Set<string>();
  if (productIds.length === 0) return stopped;
  const stops = await deps.db.select().from(stopList).where(and(eq(stopList.storeId, storeId), isNull(stopList.clearedAt)));
  if (stops.length === 0) return stopped;
  const stopIds = new Set(stops.flatMap((x) => [x.productId, x.ingredientId]).filter((x): x is string => !!x));
  const dishes = await getDishes(deps.db as unknown as Tx, productIds);
  for (const id of productIds) {
    const d = dishes.get(id);
    if (stopIds.has(id) || d?.recipe.some((i) => stopIds.has(i.product_id))) stopped.add(id);
  }
  return stopped;
}

/** Товары с актуальной ценой на точке и доступным остатком (одним запросом по списку id). SOR: наличие по стоп-листу. */
export async function priceProducts(deps: AppDeps, storeId: string, productIds: string[]): Promise<Map<string, PricedProduct>> {
  if (productIds.length === 0) return new Map();
  const now = deps.clock.now();
  const rows = await deps.db
    .select({
      id: product.id,
      brand: product.brand,
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
  const sorIds = rows.filter((r) => r.brand === 'SOR').map((r) => r.id);
  const stopped = await stoppedProductIds(deps, storeId, sorIds);
  const dishes = await getDishes(deps.db as unknown as Tx, sorIds);
  return new Map(
    rows.map((r) => [
      r.id,
      r.brand === 'SOR'
        ? { ...r, available: stopped.has(r.id) ? 0 : Number.MAX_SAFE_INTEGER, modifiersRaw: dishes.has(r.id) ? (dishes.get(r.id)!.modifiers ?? {}) : null }
        : { ...r, modifiersRaw: null },
    ]),
  );
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
    const [st] = await deps.db.select({ brands: store.brands }).from(store).where(eq(store.id, store_id));
    // каталог Lablabu на точке с кухней показывает и блюда Sor Box (ТЗ §8, этап 2)
    const withKitchen = brand === 'LAB' && !!st?.brands.includes('SOR');
    const priceJoin = and(eq(price.productId, product.id), eq(price.storeId, store_id), lte(price.validFrom, now), or(isNull(price.validTo), gt(price.validTo, now)));
    const scope = and(
      withKitchen ? sql`(${product.brand} = 'LAB' or exists (select 1 from ${dish} where ${dish.productId} = ${product.id}))` : eq(product.brand, brand),
      eq(product.isActive, true),
    );
    // поиск: русское и таджикское название, артикул, штрихкод; % и _ из ввода — буквально
    const like = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await deps.db
      .select({
        product,
        priceDirams: price.priceDirams,
        oldPriceDirams: price.oldPriceDirams,
        available: sql<number>`coalesce((select sum(${stockLot.qty} - ${stockLot.reservedQty}) from ${stockLot}
          where ${stockLot.productId} = ${product.id} and ${stockLot.storeId} = ${store_id}), 0)::int`,
      })
      .from(product)
      .innerJoin(price, priceJoin)
      .where(
        and(
          scope,
          category ? eq(product.categoryId, category) : undefined,
          like
            ? sql`(${product.nameRu} ilike ${like} or ${product.nameTj} ilike ${like} or ${product.sku} ilike ${like} or ${q!.trim()} = any(${product.barcodes}))`
            : undefined,
        ),
      )
      .orderBy(asc(product.nameRu))
      .limit(500);
    const cats = await deps.db
      .select({ id: categoryT.id, name: categoryT.name, count: count() })
      .from(product)
      .innerJoin(price, priceJoin)
      .innerJoin(categoryT, eq(categoryT.id, product.categoryId))
      .where(scope)
      .groupBy(categoryT.id, categoryT.name, categoryT.sort)
      .orderBy(asc(categoryT.sort), asc(categoryT.name));
    const sorIds = rows.filter((r) => r.product.brand === 'SOR').map((r) => r.product.id);
    const stopped = await stoppedProductIds(deps, store_id, sorIds);
    const dishes = await getDishes(deps.db as unknown as Tx, sorIds);
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
        in_stock: r.product.brand === 'SOR' ? !stopped.has(r.product.id) : r.available > 0,
        photo_url: r.product.photoUrl,
        modifiers: dishModifiersOrNull(dishes.get(r.product.id)?.modifiers),
        from_kitchen: brand === 'LAB' && r.product.brand === 'SOR',
      })),
      categories: cats,
    };
  });
}

/** Блюда Sor Box по товарам (станция, время готовки, рецептура). */
export async function getDishes(tx: Tx, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, typeof dish.$inferSelect>();
  const rows = await tx.select().from(dish).where(inArray(dish.productId, productIds));
  return new Map(rows.map((d) => [d.productId, d]));
}

function dishModifiersOrNull(raw: unknown) {
  const r = DishModifiers.safeParse(raw ?? {});
  return r.success && r.data.groups.length ? r.data : null;
}
