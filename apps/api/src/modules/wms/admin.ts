import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AdjustInput,
  CellInput,
  CellListView,
  CellView,
  ExpiringView,
  StockListView,
  StockLotView,
  StocktakeAdminView,
  StocktakeApplyResult,
  StocktakeCreate,
  StocktakeListView,
  StoreChildParams,
  StoreIdParams,
  SupplyInput,
  SupplyListView,
} from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { cell, product, stockLot, stocktake, stocktakeLine, supply, supplyItem } from '../../shared/db/schema/index.js';
import type { Tx } from '../../shared/db/client.js';
import { loadParams } from '../../shared/params/load.js';
import { isSellable } from './reserve.js';
import { audit } from '../../shared/audit.js';
import { ref } from '../../shared/db/sql.js';
import { requireStaff } from '../../shared/auth/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { adjustLot, surplusLot } from './stock.js';

/** Склад в админке (ТЗ §7, §9): ячейки, документы поставки, остатки, корректировка после пересчёта. */

const tags = ['admin'];
const sec = [{ bearer: [] }];

export async function registerWmsAdmin(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/stores/:store_id/cells', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: CellListView } } }, async (req) => {
    requireStaff(req.principal, 'stores.read', req.params.store_id);
    const rows = await deps.db
      .select({ c: cell, used: sql<number>`coalesce((select sum(${stockLot.qty}) from ${stockLot} where ${stockLot.cellId} = ${ref(cell.id)}), 0)::int` })
      .from(cell)
      .where(eq(cell.storeId, req.params.store_id))
      .orderBy(asc(cell.pickSeq));
    return {
      cells: rows.map(({ c, used }) => ({ id: c.id, code: c.code, temp_zone: c.tempZone, is_camera_covered: c.isCameraCovered, pick_seq: c.pickSeq, capacity_units: c.capacityUnits, is_active: c.isActive, used_units: used })),
    };
  });

  r.post('/admin/stores/:store_id/cells', { schema: { tags, security: sec, params: StoreIdParams, body: CellInput, response: { 201: CellView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'wms.cells.write', req.params.store_id);
    const b = req.body;
    const c = await deps.db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: cell.id }).from(cell).where(and(eq(cell.storeId, req.params.store_id), eq(cell.code, b.code)));
      if (dup) throw new AppError('VALIDATION', `Ячейка ${b.code} уже есть`);
      const [c] = await tx
        .insert(cell)
        .values({ storeId: req.params.store_id, code: b.code, tempZone: b.temp_zone, isCameraCovered: b.is_camera_covered, pickSeq: b.pick_seq, capacityUnits: b.capacity_units, isActive: b.is_active })
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'cell.create', objectType: 'cell', objectId: c!.id, after: b, storeId: req.params.store_id });
      return c!;
    });
    return reply.status(201).send({ id: c.id, code: c.code, temp_zone: c.tempZone, is_camera_covered: c.isCameraCovered, pick_seq: c.pickSeq, capacity_units: c.capacityUnits, is_active: c.isActive, used_units: 0 });
  });

  r.get('/admin/stores/:store_id/supplies', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: SupplyListView } } }, async (req) => {
    requireStaff(req.principal, 'wms.supply.create', req.params.store_id);
    const rows = await deps.db
      .select({ s: supply, lines: sql<number>`(select count(*)::int from ${supplyItem} where ${supplyItem.supplyId} = ${ref(supply.id)})` })
      .from(supply)
      .where(eq(supply.storeId, req.params.store_id))
      .orderBy(desc(supply.createdAt))
      .limit(100);
    return {
      supplies: rows.map(({ s, lines }) => ({ id: s.id, supplier: s.supplier, status: s.status, expected_at: s.expectedAt?.toISOString() ?? null, lines, created_at: s.createdAt.toISOString() })),
    };
  });

  r.post('/admin/stores/:store_id/supplies', { schema: { tags, security: sec, params: StoreIdParams, body: SupplyInput } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'wms.supply.create', req.params.store_id);
    const b = req.body;
    const id = await deps.db.transaction(async (tx) => {
      const [s] = await tx.insert(supply).values({ storeId: req.params.store_id, supplier: b.supplier, expectedAt: b.expected_at ? new Date(b.expected_at) : null }).returning();
      await tx.insert(supplyItem).values(b.items.map((i) => ({ supplyId: s!.id, productId: i.product_id, qtyExpected: i.qty_expected })));
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'supply.create', objectType: 'supply', objectId: s!.id, after: b, storeId: req.params.store_id });
      return s!.id;
    });
    return reply.status(201).send({ id });
  });

  /** Остатки по товарам точки: всего, в резерве, не размещено, ближайший срок. Число — только персоналу (клиенту не отдаётся). */
  r.get('/admin/stores/:store_id/stock', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: StockListView } } }, async (req) => {
    requireStaff(req.principal, 'stores.read', req.params.store_id);
    const rows = await deps.db
      .select({
        product_id: product.id,
        name: product.nameRu,
        sku: product.sku,
        unit: product.unit,
        qty: sql<number>`sum(${stockLot.qty})::int`,
        reserved_qty: sql<number>`sum(${stockLot.reservedQty})::int`,
        unplaced_qty: sql<number>`coalesce(sum(${stockLot.qty}) filter (where ${stockLot.cellId} is null), 0)::int`,
        nearest_expiry: sql<Date | null>`min(${stockLot.expiresAt}) filter (where ${stockLot.qty} > 0)`,
      })
      .from(stockLot)
      .innerJoin(product, eq(product.id, stockLot.productId))
      .where(eq(stockLot.storeId, req.params.store_id))
      .groupBy(product.id, product.nameRu, product.sku, product.unit)
      .orderBy(asc(product.nameRu));
    return { rows: rows.map((r) => ({ ...r, nearest_expiry: r.nearest_expiry ? new Date(r.nearest_expiry).toISOString() : null })) };
  });

  /** Сроки (ТЗ §7): истёкшие — в списание; ниже MIN_SHELF_LIFE_PCT или ≤ 2 дней — на уценку (такие не резервируются). */
  r.get('/admin/stores/:store_id/expiring', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: ExpiringView } } }, async (req) => {
    requireStaff(req.principal, 'stores.read', req.params.store_id);
    const now = deps.clock.now();
    const P = await loadParams(deps.db, req.params.store_id);
    const rows = await deps.db
      .select({ l: stockLot, name: product.nameRu, sku: product.sku, life: product.shelfLifeDays, code: cell.code })
      .from(stockLot)
      .innerJoin(product, eq(product.id, stockLot.productId))
      .leftJoin(cell, eq(cell.id, stockLot.cellId))
      .where(and(eq(stockLot.storeId, req.params.store_id), sql`${stockLot.qty} > 0`, sql`${stockLot.expiresAt} is not null`, sql`${stockLot.expiresAt} < ${new Date(now.getTime() + 30 * 86_400_000)}`))
      .orderBy(asc(stockLot.expiresAt));
    const out = [];
    for (const r of rows) {
      const exp = r.l.expiresAt!;
      const total = r.life ? r.life * 86_400_000 : exp.getTime() - r.l.createdAt.getTime();
      const leftPct = total > 0 ? Math.max(0, Math.round(((exp.getTime() - now.getTime()) / total) * 1000) / 10) : 0;
      const sellable = isSellable({ id: r.l.id, qty: r.l.qty, reservedQty: r.l.reservedQty, expiresAt: exp, receivedAt: r.l.createdAt, shelfLifeDays: r.life }, now, P.MIN_SHELF_LIFE_PCT);
      const soon = exp.getTime() - now.getTime() <= 2 * 86_400_000;
      if (sellable && !soon) continue;
      out.push({ lot_id: r.l.id, product_id: r.l.productId, name: r.name, sku: r.sku, cell_code: r.code, qty: r.l.qty - r.l.reservedQty, expires_at: exp.toISOString(), left_pct: leftPct, action: exp <= now ? ('write_off' as const) : ('markdown' as const) });
    }
    return { rows: out };
  });

  // ---- инвентаризация ----
  r.get('/admin/stores/:store_id/stocktakes', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: StocktakeListView } } }, async (req) => {
    requireStaff(req.principal, 'wms.supply.create', req.params.store_id);
    const sts = await deps.db.select().from(stocktake).where(eq(stocktake.storeId, req.params.store_id)).orderBy(desc(stocktake.createdAt)).limit(20);
    const out = [];
    for (const st of sts) out.push(await stocktakeView(deps.db as unknown as Tx, st));
    return { stocktakes: out };
  });

  r.post('/admin/stores/:store_id/stocktakes', { schema: { tags, security: sec, params: StoreIdParams, body: StocktakeCreate, response: { 201: StocktakeAdminView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'wms.supply.create', req.params.store_id);
    const view = await deps.db.transaction(async (tx) => {
      const [st] = await tx.insert(stocktake).values({ storeId: req.params.store_id, scope: req.body.scope, status: 'open' }).returning();
      const codes = req.body.scope === 'cell' ? (req.body.cell_codes ?? []) : null;
      const lots = await tx
        .select({ cellId: stockLot.cellId, productId: stockLot.productId, qty: sql<number>`sum(${stockLot.qty})::int` })
        .from(stockLot)
        .innerJoin(cell, eq(cell.id, stockLot.cellId))
        .where(and(eq(stockLot.storeId, req.params.store_id), codes ? inArray(cell.code, codes.length ? codes : ['—']) : undefined))
        .groupBy(stockLot.cellId, stockLot.productId);
      if (lots.length) await tx.insert(stocktakeLine).values(lots.map((l) => ({ stocktakeId: st!.id, cellId: l.cellId!, productId: l.productId, qtySystem: l.qty })));
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'stocktake.create', objectType: 'stocktake', objectId: st!.id, after: req.body, storeId: req.params.store_id });
      return stocktakeView(tx, st!);
    });
    return reply.status(201).send(view);
  });

  /**
   * Применить пересчёт (управляющий, ТЗ §9): по каждой посчитанной строке остаток ячейки приводится к факту —
   * недостача снимается с партий ячейки начиная с поздних сроков, излишек ложится новой партией. Строки,
   * где нужен пересчёт другим сотрудником, блокируют применение.
   */
  r.post('/admin/stores/:store_id/stocktakes/:id/apply', { schema: { tags, security: sec, params: StoreChildParams, response: { 200: StocktakeApplyResult } } }, async (req) => {
    const me = requireStaff(req.principal, 'wms.stock.adjust', req.params.store_id);
    return deps.db.transaction(async (tx) => {
      const [st] = await tx.select().from(stocktake).where(and(eq(stocktake.id, req.params.id), eq(stocktake.storeId, req.params.store_id))).for('update');
      if (!st) throw notFound('Инвентаризация', req.params.id);
      if (st.status !== 'open') throw new AppError('INVALID_TRANSITION', 'Инвентаризация уже закрыта');
      const lines = await tx.select().from(stocktakeLine).where(eq(stocktakeLine.stocktakeId, st.id));
      const blocked = lines.filter((l) => l.recountRequired && l.qtyFact !== null);
      if (blocked.length) throw new AppError('VALIDATION', 'Есть строки, которые должен пересчитать другой сотрудник', { line_ids: blocked.map((l) => l.id) });
      let adjusted = 0;
      let unchanged = 0;
      let notCounted = 0;
      for (const l of lines) {
        if (l.qtyFact === null) {
          notCounted++;
          continue;
        }
        const lots = await tx
          .select()
          .from(stockLot)
          .where(and(eq(stockLot.cellId, l.cellId), eq(stockLot.productId, l.productId)))
          .orderBy(desc(stockLot.expiresAt), desc(stockLot.createdAt))
          .for('update');
        const current = lots.reduce((a, x) => a + x.qty, 0);
        let diff = l.qtyFact - current;
        if (diff === 0) {
          unchanged++;
          continue;
        }
        adjusted++;
        const why = `инвентаризация ${st.id.slice(0, 8)}`;
        if (diff > 0) {
          await surplusLot(tx, { storeId: st.storeId, productId: l.productId, cellId: l.cellId, qty: diff, reason: why, actorId: me.staff_id });
        } else {
          for (const lot of lots) {
            if (diff === 0) break;
            const free = lot.qty - lot.reservedQty;
            const take = Math.min(free, -diff);
            if (take > 0) {
              await adjustLot(tx, lot.id, lot.qty - take, why, me.staff_id);
              diff += take;
            }
          }
          if (diff !== 0) throw new AppError('OUT_OF_STOCK', 'Недостачу нельзя списать: товар в резерве заказов', { line_id: l.id, left: -diff });
        }
      }
      await tx.update(stocktake).set({ status: 'applied' }).where(eq(stocktake.id, st.id));
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'stocktake.apply', objectType: 'stocktake', objectId: st.id, after: { adjusted, unchanged, not_counted: notCounted }, storeId: st.storeId });
      return { adjusted, unchanged, not_counted: notCounted };
    });
  });

  r.post('/admin/stores/:store_id/adjust', { schema: { tags, security: sec, params: StoreIdParams, body: AdjustInput, response: { 200: StockLotView } } }, async (req) => {
    const me = requireStaff(req.principal, 'wms.stock.adjust', req.params.store_id);
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(stockLot).where(and(eq(stockLot.id, req.body.lot_id), eq(stockLot.storeId, req.params.store_id)));
      if (!before) throw notFound('Партия', req.body.lot_id);
      await adjustLot(tx, before.id, req.body.qty_fact, req.body.reason, me.staff_id);
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'stock.adjust', objectType: 'stock_lot', objectId: before.id, before: { qty: before.qty }, after: { qty: req.body.qty_fact }, reason: req.body.reason, storeId: req.params.store_id });
      const [l] = await tx.select({ l: stockLot, code: cell.code }).from(stockLot).leftJoin(cell, eq(cell.id, stockLot.cellId)).where(eq(stockLot.id, before.id));
      return { lot_id: l!.l.id, product_id: l!.l.productId, cell_code: l!.code, qty: l!.l.qty, reserved_qty: l!.l.reservedQty, expires_at: l!.l.expiresAt?.toISOString() ?? null };
    });
  });

}

async function stocktakeView(tx: Tx, st: typeof stocktake.$inferSelect) {
  const lines = await tx
    .select({ l: stocktakeLine, code: cell.code, name: product.nameRu, unit: product.unit })
    .from(stocktakeLine)
    .innerJoin(cell, eq(cell.id, stocktakeLine.cellId))
    .innerJoin(product, eq(product.id, stocktakeLine.productId))
    .where(eq(stocktakeLine.stocktakeId, st.id))
    .orderBy(asc(cell.pickSeq));
  return {
    id: st.id,
    scope: st.scope,
    status: st.status,
    created_at: st.createdAt.toISOString(),
    lines: lines.map(({ l, code, name, unit }) => ({ id: l.id, cell_code: code, product_id: l.productId, name, unit, qty_system: l.qtySystem, qty_fact: l.qtyFact, recount_required: l.recountRequired })),
  };
}

/**
 * Ежедневная выборочная инвентаризация (ТЗ §7): в открытый daily-пересчёт точки добавляются все ячейки с дорогим
 * товаром (ячейки с недобором при сборке попадают туда в течение дня из сценария «нет на полке»).
 */
export async function planDailyStocktake(tx: Tx, storeId: string) {
  const [open] = await tx.select().from(stocktake).where(and(eq(stocktake.storeId, storeId), eq(stocktake.status, 'open'), eq(stocktake.scope, 'daily')));
  const st = open ?? (await tx.insert(stocktake).values({ storeId, scope: 'daily', status: 'open' }).returning())[0]!;
  const hv = await tx
    .select({ cellId: stockLot.cellId, productId: stockLot.productId, qty: sql<number>`sum(${stockLot.qty})::int` })
    .from(stockLot)
    .innerJoin(product, eq(product.id, stockLot.productId))
    .where(and(eq(stockLot.storeId, storeId), eq(product.isHighValue, true), sql`${stockLot.cellId} is not null`, sql`${stockLot.qty} > 0`))
    .groupBy(stockLot.cellId, stockLot.productId);
  const existing = await tx.select().from(stocktakeLine).where(eq(stocktakeLine.stocktakeId, st.id));
  const fresh = hv.filter((h) => !existing.some((e) => e.cellId === h.cellId && e.productId === h.productId));
  if (fresh.length) await tx.insert(stocktakeLine).values(fresh.map((h) => ({ stocktakeId: st.id, cellId: h.cellId!, productId: h.productId, qtySystem: h.qty })));
  return { stocktake_id: st.id, added: fresh.length };
}
