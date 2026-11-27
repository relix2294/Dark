import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AdjustInput, CellInput, CellListView, CellView, StockListView, StockLotView, StoreIdParams, SupplyInput, SupplyListView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { cell, product, stockLot, supply, supplyItem } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { ref } from '../../shared/db/sql.js';
import { requireStaff } from '../../shared/auth/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { adjustLot } from './stock.js';

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
        qty: sql<number>`sum(${stockLot.qty})::int`,
        reserved_qty: sql<number>`sum(${stockLot.reservedQty})::int`,
        unplaced_qty: sql<number>`coalesce(sum(${stockLot.qty}) filter (where ${stockLot.cellId} is null), 0)::int`,
        nearest_expiry: sql<Date | null>`min(${stockLot.expiresAt}) filter (where ${stockLot.qty} > 0)`,
      })
      .from(stockLot)
      .innerJoin(product, eq(product.id, stockLot.productId))
      .where(eq(stockLot.storeId, req.params.store_id))
      .groupBy(product.id, product.nameRu, product.sku)
      .orderBy(asc(product.nameRu));
    return { rows: rows.map((r) => ({ ...r, nearest_expiry: r.nearest_expiry ? new Date(r.nearest_expiry).toISOString() : null })) };
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
