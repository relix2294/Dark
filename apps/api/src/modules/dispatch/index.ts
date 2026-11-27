/**
 * Диспетчер курьеров: смены, геопозиция, назначение, доставка (ТЗ §6). Приложение курьера — /courier/*.
 * Другие модули импортируют только из этого index.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CourierOrderIdParams,
  CourierSelfView,
  CourierTaskIdParams,
  DeliveredRequest,
  DeliveryTaskView,
  NoShowRequest,
  PickupRequest,
  PositionBatch,
  ShiftStartRequest, ShiftSummaryView } from '@dark/contracts';
import { shiftSummary } from './shift-summary.js';
import type { AppDeps } from '../../app.js';
import { requireStaff } from '../../shared/auth/index.js';
import * as svc from './service.js';

export { planDispatch, type DispatchInput, type DispatchResult } from './planner.js';
export { taskMachine, courierMachine } from './state-machine.js';
export { dispatchStore, detachOrder, confirmDeliveredByLead, manualAssign, markReturned, consoleCouriers, courierForOrder, unassign } from './service.js';
export { ensureCourier, registerCourierPlan } from './plan.js';

export async function registerDispatch(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['courier'];
  const sec = [{ bearer: [] }];
  const me = (p: Parameters<typeof requireStaff>[0]) => requireStaff(p, 'courier.app');

  r.get('/courier/me', { schema: { tags, security: sec, response: { 200: CourierSelfView } } }, async (req) => svc.selfView(deps, me(req.principal)));
  r.post('/courier/shift/start', { schema: { tags, security: sec, body: ShiftStartRequest, response: { 200: CourierSelfView } } }, async (req) =>
    svc.shiftStart(deps, me(req.principal), req.body.transport),
  );
  r.post('/courier/shift/end', { schema: { tags, security: sec, response: { 200: CourierSelfView } } }, async (req) => svc.shiftEnd(deps, me(req.principal)));
  r.get('/courier/shift/summary', { schema: { tags, security: sec, response: { 200: ShiftSummaryView.nullable() } } }, async (req) => shiftSummary(deps, me(req.principal)));
  r.post('/courier/shift/break', { schema: { tags, security: sec, response: { 200: CourierSelfView } } }, async (req) => svc.shiftBreak(deps, me(req.principal)));

  /** Телеметрия — без Idempotency-Key: пакеты точек дедуплицируются по времени события на клиенте и безвредны при повторе. */
  r.post('/courier/position', { config: { idempotency: false }, schema: { tags, security: sec, body: PositionBatch, response: { 200: z.object({ accepted: z.number().int() }) } } }, async (req) =>
    svc.positions(deps, me(req.principal), req.body.points),
  );

  r.get('/courier/tasks/current', { schema: { tags, security: sec, response: { 200: DeliveryTaskView.nullable() } } }, async (req) => svc.currentTask(deps, me(req.principal)));
  r.post('/courier/tasks/:id/accept', { schema: { tags, security: sec, params: CourierTaskIdParams, response: { 200: DeliveryTaskView } } }, async (req) =>
    svc.accept(deps, me(req.principal), req.params.id),
  );
  r.post('/courier/tasks/:id/pickup', { schema: { tags, security: sec, params: CourierTaskIdParams, body: PickupRequest, response: { 200: DeliveryTaskView } } }, async (req) =>
    svc.pickup(deps, me(req.principal), req.params.id, req.body.package_barcodes, req.body.at),
  );
  r.post('/courier/orders/:id/delivered', { schema: { tags, security: sec, params: CourierOrderIdParams, body: DeliveredRequest } }, async (req) =>
    svc.delivered(deps, requireStaff(req.principal, 'courier.app'), req.params.id, req.body.geo, req.body.photo_url, req.body.at),
  );
  r.post('/courier/orders/:id/no-show', { schema: { tags, security: sec, params: CourierOrderIdParams, body: NoShowRequest, response: { 200: DeliveryTaskView } } }, async (req) =>
    svc.noShow(deps, me(req.principal), req.params.id, req.body.comment, req.body.at),
  );
}
