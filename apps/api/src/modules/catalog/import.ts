import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ImportRequest, ImportResult, ImportRow } from '@dark/contracts';
import type { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { category, price, product } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { requireStaff } from '../../shared/auth/index.js';

/**
 * Импорт каталога (тысячи SKU дарк-стора). Два шага: dry_run — проверка и сводка без записи;
 * затем применение одной транзакцией: либо вся пачка, либо ничего. Ошибка в любой строке блокирует применение.
 * Проверки: схема строки, дубли артикула и штрихкода в файле, штрихкод у другого товара в базе.
 */

type Row = z.infer<typeof ImportRow>;
class Rollback extends Error {}

export async function registerCatalogImport(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/admin/products/import', { bodyLimit: 5 * 1024 * 1024, schema: { tags: ['admin'], security: [{ bearer: [] }], body: ImportRequest, response: { 200: ImportResult } } }, async (req) => {
    const me = requireStaff(req.principal, 'catalog.write', req.body.store_id);
    const { brand, store_id, dry_run, reason } = req.body;
    const errors: { row: number; message: string }[] = [];
    const rows: (Row & { _n: number })[] = [];

    // 1. схема каждой строки (номер строки — как в файле, с заголовком: +2)
    req.body.rows.forEach((raw, i) => {
      const p = ImportRow.safeParse(raw);
      if (p.success) rows.push({ ...p.data, _n: i + 2 });
      else errors.push({ row: i + 2, message: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    });

    // 2. дубли внутри файла
    const skuSeen = new Map<string, number>();
    const bcSeen = new Map<string, string>();
    for (const row of rows) {
      const prev = skuSeen.get(row.sku);
      if (prev) errors.push({ row: row._n, message: `артикул ${row.sku} уже в строке ${prev}` });
      skuSeen.set(row.sku, row._n);
      for (const b of row.barcodes) {
        const other = bcSeen.get(b);
        if (other && other !== row.sku) errors.push({ row: row._n, message: `штрихкод ${b} уже у артикула ${other} в файле` });
        bcSeen.set(b, row.sku);
      }
    }

    const result = { dry_run, applied: false, created: 0, updated: 0, prices_changed: 0, categories_created: [] as string[], errors };
    try {
      await deps.db.transaction(async (tx) => {
        const existing = await loadExisting(tx, brand, rows.map((x) => x.sku));
        // 3. штрихкод уже у другого товара в базе
        const allBc = [...bcSeen.keys()];
        if (allBc.length) {
          const owners = await tx.select({ sku: product.sku, brand: product.brand, barcodes: product.barcodes }).from(product);
          const byBc = new Map<string, string>();
          for (const o of owners) for (const b of o.barcodes) byBc.set(b, `${o.brand}:${o.sku}`);
          for (const row of rows)
            for (const b of row.barcodes) {
              const owner = byBc.get(b);
              if (owner && owner !== `${brand}:${row.sku}`) errors.push({ row: row._n, message: `штрихкод ${b} уже у товара ${owner}` });
            }
        }

        // категории по имени: недостающие будут созданы
        const cats = await tx.select().from(category).where(eq(category.brand, brand));
        const catId = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
        const missing = [...new Set(rows.map((x) => x.category?.trim()).filter((x): x is string => !!x && !catId.has(x.toLowerCase())))];
        result.categories_created = missing;

        const now = deps.clock.now();
        const curPrices = existing.size
          ? await tx.select().from(price).where(and(inArray(price.productId, [...existing.values()].map((p) => p.id)), eq(price.storeId, store_id), isNull(price.validTo)))
          : [];

        for (const row of rows) {
          const ex = existing.get(row.sku);
          if (ex) result.updated++;
          else result.created++;
          const cur = ex ? curPrices.find((p) => p.productId === ex.id) : undefined;
          if (row.price_dirams !== undefined && row.price_dirams !== cur?.priceDirams) result.prices_changed++;
        }

        if (dry_run || errors.length) throw new Rollback();

        // 4. применение
        for (const name of missing) {
          const [c] = await tx.insert(category).values({ brand, name }).returning();
          catId.set(name.toLowerCase(), c!.id);
        }
        for (const row of rows) {
          const fields = {
            nameRu: row.name_ru,
            ...(row.name_tj !== undefined && { nameTj: row.name_tj }),
            ...(row.category !== undefined && { categoryId: row.category ? catId.get(row.category.trim().toLowerCase())! : null }),
            ...(row.barcodes.length && { barcodes: row.barcodes }),
            ...(row.unit !== undefined && { unit: row.unit }),
            ...(row.temp_zone !== undefined && { tempZone: row.temp_zone }),
            ...(row.is_weighted !== undefined && { isWeighted: row.is_weighted }),
            ...(row.is_high_value !== undefined && { isHighValue: row.is_high_value }),
            ...(row.shelf_life_days !== undefined && { shelfLifeDays: row.shelf_life_days }),
            ...(row.is_active !== undefined && { isActive: row.is_active }),
          };
          const ex = existing.get(row.sku);
          const id = ex ? ex.id : (await tx.insert(product).values({ brand, sku: row.sku, ...fields }).returning({ id: product.id }))[0]!.id;
          if (ex) await tx.update(product).set(fields).where(eq(product.id, ex.id));
          if (row.price_dirams !== undefined) {
            const cur = curPrices.find((p) => p.productId === id);
            if (cur?.priceDirams !== row.price_dirams) {
              if (cur) await tx.update(price).set({ validTo: now }).where(eq(price.id, cur.id));
              await tx.insert(price).values({ productId: id, storeId: store_id, priceDirams: row.price_dirams, validFrom: now });
            }
          }
        }
        await audit(tx, {
          actorType: 'staff',
          actorId: me.staff_id,
          action: 'catalog.import',
          objectType: 'catalog',
          objectId: `${brand}:${store_id}`,
          after: { created: result.created, updated: result.updated, prices_changed: result.prices_changed, categories_created: missing },
          reason,
          storeId: store_id,
        });
        result.applied = true;
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    errors.sort((a, b) => a.row - b.row);
    return result;
  });
}

async function loadExisting(tx: Tx, brand: 'LAB' | 'SOR', skus: string[]) {
  if (skus.length === 0) return new Map<string, { id: string }>();
  const rows = await tx.select({ id: product.id, sku: product.sku }).from(product).where(and(eq(product.brand, brand), inArray(product.sku, skus)));
  return new Map(rows.map((r) => [r.sku, { id: r.id }]));
}
