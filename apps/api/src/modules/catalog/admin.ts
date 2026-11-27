import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  CategoryInput,
  DishModifiers,
  CategoryListView,
  CategoryQuery,
  CategoryView,
  DishInput,
  IdParams,
  PriceInput,
  ProductInput,
  ProductListView,
  ProductPatch,
  ProductQuery,
  ProductView,
  StoreChildParams,
  StoreIdParams,
  StoreInput,
  StoreListView,
  StorePatch,
  StoreView,
  ZoneInput,
  ZoneListView,
  ZonePatch,
  ZoneView,
} from '@dark/contracts';
import type { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { category, deliveryZone, dish, price, product, store } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { requireStaff } from '../../shared/auth/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';

/** Админка каталога (ТЗ §9): точки, категории, товары, цены с историей, блюда, зоны доставки. */

const tags = ['admin'];
const sec = [{ bearer: [] }];

const storeView = (s: typeof store.$inferSelect): z.infer<typeof StoreView> => ({
  id: s.id,
  code: s.code,
  name: s.name,
  address: s.address,
  geo: { lat: s.lat, lon: s.lon },
  brands: s.brands as ('LAB' | 'SOR')[],
  work_hours: s.workHours,
  is_active: s.isActive,
});

const zoneView = (z: typeof deliveryZone.$inferSelect): z.infer<typeof ZoneView> => ({
  id: z.id,
  store_id: z.storeId,
  brand: z.brand,
  polygon: z.polygon,
  fee_dirams: z.feeDirams,
  min_order_dirams: z.minOrderDirams,
  eta_min: z.etaMin,
  eta_max: z.etaMax,
  is_active: z.isActive,
});

async function productViews(tx: Tx, rows: (typeof product.$inferSelect)[], now: Date): Promise<z.infer<typeof ProductView>[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const prices = await tx
    .select()
    .from(price)
    .where(and(inArray(price.productId, ids), sql`${price.validFrom} <= ${now}`, or(isNull(price.validTo), sql`${price.validTo} > ${now}`)));
  const dishes = await tx.select().from(dish).where(inArray(dish.productId, ids));
  return rows.map((p) => {
    const d = dishes.find((x) => x.productId === p.id);
    return {
      id: p.id,
      brand: p.brand,
      sku: p.sku,
      name_ru: p.nameRu,
      name_tj: p.nameTj,
      category_id: p.categoryId,
      barcodes: p.barcodes,
      unit: p.unit,
      weight_g: p.weightG,
      is_weighted: p.isWeighted,
      temp_zone: p.tempZone,
      is_high_value: p.isHighValue,
      is_age_restricted: p.isAgeRestricted,
      shelf_life_days: p.shelfLifeDays,
      photo_url: p.photoUrl,
      is_active: p.isActive,
      prices: prices
        .filter((x) => x.productId === p.id)
        .map((x) => ({ store_id: x.storeId, price_dirams: x.priceDirams, old_price_dirams: x.oldPriceDirams, valid_from: x.validFrom.toISOString() })),
      dish: d ? { station: d.station, cook_time_sec: d.cookTimeSec, modifiers: DishModifiers.safeParse(d.modifiers ?? {}).data ?? { groups: [] }, recipe: d.recipe } : null,
    };
  });
}

type ProductFields = { [K in keyof z.infer<typeof ProductInput>]?: z.infer<typeof ProductInput>[K] | undefined };
const productRow = (b: ProductFields) => ({
  ...(b.brand !== undefined && { brand: b.brand }),
  ...(b.sku !== undefined && { sku: b.sku }),
  ...(b.name_ru !== undefined && { nameRu: b.name_ru }),
  ...(b.name_tj !== undefined && { nameTj: b.name_tj }),
  ...(b.category_id !== undefined && { categoryId: b.category_id }),
  ...(b.barcodes !== undefined && { barcodes: b.barcodes }),
  ...(b.unit !== undefined && { unit: b.unit }),
  ...(b.weight_g !== undefined && { weightG: b.weight_g }),
  ...(b.is_weighted !== undefined && { isWeighted: b.is_weighted }),
  ...(b.temp_zone !== undefined && { tempZone: b.temp_zone }),
  ...(b.is_high_value !== undefined && { isHighValue: b.is_high_value }),
  ...(b.is_age_restricted !== undefined && { isAgeRestricted: b.is_age_restricted }),
  ...(b.shelf_life_days !== undefined && { shelfLifeDays: b.shelf_life_days }),
  ...(b.photo_url !== undefined && { photoUrl: b.photo_url }),
  ...(b.is_active !== undefined && { isActive: b.is_active }),
});

/** Штрихкод уникален среди товаров: иначе сборщик не отличит товар (ТЗ §7). */
async function assertBarcodesFree(tx: Tx, barcodes: string[], exceptId?: string) {
  if (barcodes.length === 0) return;
  const clash = await tx
    .select({ id: product.id, sku: product.sku })
    .from(product)
    .where(
      and(
        sql`${product.barcodes} && ARRAY[${sql.join(barcodes.map((b) => sql`${b}`), sql`, `)}]::text[]`,
        exceptId ? sql`${product.id} <> ${exceptId}` : undefined,
      ),
    );
  if (clash.length) throw new AppError('VALIDATION', 'Штрихкод уже у другого товара', { sku: clash[0]!.sku });
}

export async function registerCatalogAdmin(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- точки ----
  r.get('/admin/stores', { schema: { tags, security: sec, response: { 200: StoreListView } } }, async (req) => {
    const me = requireStaff(req.principal, 'stores.read');
    const rows = await deps.db.select().from(store).where(me.store_id ? eq(store.id, me.store_id) : undefined).orderBy(asc(store.code));
    return { stores: rows.map(storeView) };
  });
  r.post('/admin/stores', { schema: { tags, security: sec, body: StoreInput, response: { 201: StoreView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'stores.write');
    const b = req.body;
    const created = await deps.db.transaction(async (tx) => {
      const [s] = await tx
        .insert(store)
        .values({ code: b.code, name: b.name, address: b.address, lat: b.geo.lat, lon: b.geo.lon, brands: b.brands, workHours: b.work_hours, isActive: b.is_active })
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'store.create', objectType: 'store', objectId: s!.id, after: b, storeId: s!.id });
      return s!;
    });
    return reply.status(201).send(storeView(created));
  });
  r.patch('/admin/stores/:id', { schema: { tags, security: sec, params: IdParams, body: StorePatch, response: { 200: StoreView } } }, async (req) => {
    const me = requireStaff(req.principal, 'stores.write');
    const b = req.body;
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(store).where(eq(store.id, req.params.id)).for('update');
      if (!before) throw notFound('Точка', req.params.id);
      const [s] = await tx
        .update(store)
        .set({
          ...(b.code !== undefined && { code: b.code }),
          ...(b.name !== undefined && { name: b.name }),
          ...(b.address !== undefined && { address: b.address }),
          ...(b.geo !== undefined && { lat: b.geo.lat, lon: b.geo.lon }),
          ...(b.brands !== undefined && { brands: b.brands }),
          ...(b.work_hours !== undefined && { workHours: b.work_hours }),
          ...(b.is_active !== undefined && { isActive: b.is_active }),
        })
        .where(eq(store.id, req.params.id))
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'store.update', objectType: 'store', objectId: s!.id, before: storeView(before), after: b, storeId: s!.id });
      return storeView(s!);
    });
  });

  // ---- категории ----
  r.get('/admin/categories', { schema: { tags, security: sec, querystring: CategoryQuery, response: { 200: CategoryListView } } }, async (req) => {
    requireStaff(req.principal, 'catalog.write');
    const rows = await deps.db.select().from(category).where(req.query.brand ? eq(category.brand, req.query.brand) : undefined).orderBy(asc(category.sort), asc(category.name));
    return { categories: rows.map((c) => ({ id: c.id, brand: c.brand, name: c.name, sort: c.sort, parent_id: c.parentId })) };
  });
  r.post('/admin/categories', { schema: { tags, security: sec, body: CategoryInput, response: { 201: CategoryView } } }, async (req, reply) => {
    requireStaff(req.principal, 'catalog.write');
    const [c] = await deps.db.insert(category).values({ brand: req.body.brand, name: req.body.name, sort: req.body.sort, parentId: req.body.parent_id }).returning();
    return reply.status(201).send({ id: c!.id, brand: c!.brand, name: c!.name, sort: c!.sort, parent_id: c!.parentId });
  });

  // ---- товары ----
  r.get('/admin/products', { schema: { tags, security: sec, querystring: ProductQuery, response: { 200: ProductListView } } }, async (req) => {
    requireStaff(req.principal, 'catalog.write');
    const { brand, q, category_id, limit, offset } = req.query;
    const where: SQL | undefined = and(
      brand ? eq(product.brand, brand) : undefined,
      category_id ? eq(product.categoryId, category_id) : undefined,
      q ? or(ilike(product.nameRu, `%${q}%`), ilike(product.sku, `%${q}%`), sql`${q} = any(${product.barcodes})`) : undefined,
    );
    return deps.db.transaction(async (tx) => {
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(product).where(where);
      const rows = await tx.select().from(product).where(where).orderBy(desc(product.isActive), asc(product.nameRu)).limit(limit).offset(offset);
      return { products: await productViews(tx, rows, deps.clock.now()), total: n };
    });
  });
  r.post('/admin/products', { schema: { tags, security: sec, body: ProductInput, response: { 201: ProductView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'catalog.write');
    const view = await deps.db.transaction(async (tx) => {
      await assertBarcodesFree(tx, req.body.barcodes);
      const [p] = await tx.insert(product).values(productRow(req.body) as typeof product.$inferInsert).returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'product.create', objectType: 'product', objectId: p!.id, after: req.body });
      return (await productViews(tx, [p!], deps.clock.now()))[0]!;
    });
    return reply.status(201).send(view);
  });
  r.patch('/admin/products/:id', { schema: { tags, security: sec, params: IdParams, body: ProductPatch, response: { 200: ProductView } } }, async (req) => {
    const me = requireStaff(req.principal, 'catalog.write');
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(product).where(eq(product.id, req.params.id)).for('update');
      if (!before) throw notFound('Товар', req.params.id);
      if (req.body.barcodes) await assertBarcodesFree(tx, req.body.barcodes, before.id);
      const [p] = await tx.update(product).set(productRow(req.body)).where(eq(product.id, before.id)).returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'product.update', objectType: 'product', objectId: p!.id, before, after: req.body });
      return (await productViews(tx, [p!], deps.clock.now()))[0]!;
    });
  });

  /** Цена на точке: закрываем текущую, открываем новую. Изменение цены — обязательно в журнал (ТЗ §10). */
  r.put('/admin/products/:id/price', { schema: { tags, security: sec, params: IdParams, body: PriceInput, response: { 200: ProductView } } }, async (req) => {
    const me = requireStaff(req.principal, 'catalog.write', req.body.store_id);
    const now = deps.clock.now();
    return deps.db.transaction(async (tx) => {
      const [p] = await tx.select().from(product).where(eq(product.id, req.params.id));
      if (!p) throw notFound('Товар', req.params.id);
      const [cur] = await tx
        .select()
        .from(price)
        .where(and(eq(price.productId, p.id), eq(price.storeId, req.body.store_id), isNull(price.validTo)))
        .for('update');
      if (cur) await tx.update(price).set({ validTo: now }).where(eq(price.id, cur.id));
      await tx.insert(price).values({ productId: p.id, storeId: req.body.store_id, priceDirams: req.body.price_dirams, oldPriceDirams: req.body.old_price_dirams, validFrom: now });
      await audit(tx, {
        actorType: 'staff',
        actorId: me.staff_id,
        action: 'price.set',
        objectType: 'product',
        objectId: p.id,
        before: cur ? { price_dirams: cur.priceDirams, old_price_dirams: cur.oldPriceDirams } : null,
        after: { price_dirams: req.body.price_dirams, old_price_dirams: req.body.old_price_dirams },
        reason: req.body.reason,
        storeId: req.body.store_id,
      });
      return (await productViews(tx, [p], now))[0]!;
    });
  });

  r.put('/admin/products/:id/dish', { schema: { tags, security: sec, params: IdParams, body: DishInput, response: { 200: ProductView } } }, async (req) => {
    const me = requireStaff(req.principal, 'catalog.write');
    return deps.db.transaction(async (tx) => {
      const [p] = await tx.select().from(product).where(eq(product.id, req.params.id));
      if (!p) throw notFound('Товар', req.params.id);
      if (p.brand !== 'SOR') throw new AppError('VALIDATION', 'Блюдо бывает только у товара Sor Box');
      const v = { station: req.body.station, cookTimeSec: req.body.cook_time_sec, modifiers: req.body.modifiers, recipe: req.body.recipe };
      await tx.insert(dish).values({ productId: p.id, ...v }).onConflictDoUpdate({ target: dish.productId, set: v });
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'dish.set', objectType: 'product', objectId: p.id, after: req.body });
      return (await productViews(tx, [p], deps.clock.now()))[0]!;
    });
  });

  // ---- зоны доставки ----
  r.get('/admin/stores/:store_id/zones', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: ZoneListView } } }, async (req) => {
    requireStaff(req.principal, 'stores.read', req.params.store_id);
    const rows = await deps.db.select().from(deliveryZone).where(eq(deliveryZone.storeId, req.params.store_id)).orderBy(asc(deliveryZone.brand));
    return { zones: rows.map(zoneView) };
  });
  r.post('/admin/stores/:store_id/zones', { schema: { tags, security: sec, params: StoreIdParams, body: ZoneInput, response: { 201: ZoneView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'catalog.write', req.params.store_id);
    const b = req.body;
    if (b.eta_min > b.eta_max) throw new AppError('VALIDATION', 'eta_min больше eta_max');
    const z = await deps.db.transaction(async (tx) => {
      const [z] = await tx
        .insert(deliveryZone)
        .values({ storeId: req.params.store_id, brand: b.brand, polygon: b.polygon, feeDirams: b.fee_dirams, minOrderDirams: b.min_order_dirams, etaMin: b.eta_min, etaMax: b.eta_max, isActive: b.is_active })
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'zone.create', objectType: 'delivery_zone', objectId: z!.id, after: b, storeId: req.params.store_id });
      return z!;
    });
    return reply.status(201).send(zoneView(z));
  });
  r.patch('/admin/stores/:store_id/zones/:id', { schema: { tags, security: sec, params: StoreChildParams, body: ZonePatch, response: { 200: ZoneView } } }, async (req) => {
    const me = requireStaff(req.principal, 'catalog.write', req.params.store_id);
    const { reason, ...b } = req.body;
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(deliveryZone).where(and(eq(deliveryZone.id, req.params.id), eq(deliveryZone.storeId, req.params.store_id))).for('update');
      if (!before) throw notFound('Зона', req.params.id);
      const [z] = await tx
        .update(deliveryZone)
        .set({
          ...(b.brand !== undefined && { brand: b.brand }),
          ...(b.polygon !== undefined && { polygon: b.polygon }),
          ...(b.fee_dirams !== undefined && { feeDirams: b.fee_dirams }),
          ...(b.min_order_dirams !== undefined && { minOrderDirams: b.min_order_dirams }),
          ...(b.eta_min !== undefined && { etaMin: b.eta_min }),
          ...(b.eta_max !== undefined && { etaMax: b.eta_max }),
          ...(b.is_active !== undefined && { isActive: b.is_active }),
        })
        .where(eq(deliveryZone.id, before.id))
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'zone.update', objectType: 'delivery_zone', objectId: z!.id, before: zoneView(before), after: b, reason, storeId: req.params.store_id });
      return zoneView(z!);
    });
  });
}
