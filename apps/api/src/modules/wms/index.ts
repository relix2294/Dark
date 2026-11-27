/**
 * Склад Lablabu: ячейки, партии, приёмка, размещение, сборка, инвентаризация (ТЗ §7).
 * Другие модули импортируют только из этого index.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  MissingDecision,
  PickLabelView,
  PickScanRequest,
  PickTaskView,
  PlaceRequest,
  PlaceSuggestion,
  ReceiveRequest,
  StockLotView,
  StocktakeCountRequest,
  StocktakeIdParams,
  StocktakeLineView,
  SupplyIdParams,
  SupplyView,
  TaskIdParams,
  WriteOffRequest,
} from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { requireStaff, requireStaffAny } from '../../shared/auth/index.js';
import * as svc from './service.js';

export { planReserve, isSellable, type Lot, type ReservePlan } from './reserve.js';
export { suggestCells, rejectCell, type CellCandidate, type ProductToPlace } from './placement.js';
export { reserveForOrder, unreserve, reservedByLot, adjustLot, consumeIngredients } from './stock.js';

export async function registerWms(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['wms'];
  const sec = [{ bearer: [] }];

  r.get('/wms/pick-tasks/next', { schema: { tags, security: sec, response: { 200: PickTaskView.nullable() } } }, async (req) =>
    svc.nextPickTask(deps, requireStaff(req.principal, 'wms.pick')),
  );
  r.get('/wms/pick-tasks/:id', { schema: { tags, security: sec, params: TaskIdParams, response: { 200: PickTaskView } } }, async (req) =>
    svc.getTask(deps, requireStaff(req.principal, 'wms.pick'), req.params.id),
  );
  r.post('/wms/pick-tasks/:id/scan', { schema: { tags, security: sec, params: TaskIdParams, body: PickScanRequest, response: { 200: PickTaskView } } }, async (req) =>
    svc.scan(deps, requireStaff(req.principal, 'wms.pick'), req.params.id, req.body),
  );
  r.post('/wms/pick-tasks/:id/missing', { schema: { tags, security: sec, params: TaskIdParams, body: MissingDecision, response: { 200: PickTaskView } } }, async (req) =>
    svc.missing(deps, requireStaff(req.principal, 'wms.pick'), req.params.id, req.body.order_item_id, req.body.decision),
  );
  r.post('/wms/pick-tasks/:id/complete', { schema: { tags, security: sec, params: TaskIdParams, response: { 200: PickLabelView } } }, async (req) =>
    svc.complete(deps, requireStaff(req.principal, 'wms.pick'), req.params.id),
  );

  r.get('/wms/supplies/:id', { schema: { tags, security: sec, params: SupplyIdParams, response: { 200: SupplyView } } }, async (req) =>
    svc.supplyView(deps, requireStaff(req.principal, 'wms.receive'), req.params.id),
  );
  r.post('/wms/supplies/:id/receive', { schema: { tags, security: sec, params: SupplyIdParams, body: ReceiveRequest, response: { 200: StockLotView } } }, async (req) =>
    svc.receive(deps, requireStaff(req.principal, 'wms.receive'), req.params.id, req.body),
  );
  r.get('/wms/lots/:id/suggest', { schema: { tags, security: sec, params: z.object({ id: z.uuid() }), response: { 200: PlaceSuggestion } } }, async (req) =>
    svc.suggestPlacement(deps, requireStaff(req.principal, 'wms.place'), req.params.id),
  );
  r.post('/wms/place', { schema: { tags, security: sec, body: PlaceRequest, response: { 200: StockLotView } } }, async (req) =>
    svc.place(deps, requireStaff(req.principal, 'wms.place'), req.body),
  );
  r.post('/wms/write-off', { schema: { tags, security: sec, body: WriteOffRequest } }, async (req) =>
    svc.writeOff(deps, requireStaffAny(req.principal, ['wms.write_off.request', 'wms.write_off.approve']), req.body),
  );
  r.post('/wms/stocktakes/:id/count', { schema: { tags, security: sec, params: StocktakeIdParams, body: StocktakeCountRequest, response: { 200: StocktakeLineView } } }, async (req) =>
    svc.count(deps, requireStaff(req.principal, 'wms.pick'), req.params.id, req.body),
  );
}
