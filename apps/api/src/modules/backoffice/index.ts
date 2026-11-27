import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ConsoleCouriersView,
  ConsoleOrderParams,
  ConsoleOrdersView,
  ConsoleStoreParams,
  DeliveryTaskView,
  ManualAssignRequest,
  RefundRequest,
  RefundView,
  ReturnedRequest,
  StaffCancelRequest,
} from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { cancelByStaff, consoleOrders } from '../orders/index.js';
import { consoleCouriers, manualAssign, markReturned } from '../dispatch/index.js';
import { refund } from '../payments/index.js';
export { registerReports } from './reports.js';
import { auditLog, parameter } from '../../shared/db/schema/index.js';
import { audit as auditDb, type AuditEntry } from '../../shared/audit.js';
import { requireStaff, requireStaffAny } from '../../shared/auth/index.js';
import { DEFAULT_PARAMS, resolveParams, type ParamKey } from '../../shared/params/index.js';

/**
 * Модуль backoffice: параметры по точке (ТЗ §12), журнал действий (ТЗ §10). Каталог, цены, промо,
 * персонал, отчёты — следующие итерации, в этом же модуле.
 */
export async function getParams(deps: AppDeps, storeId: string | null) {
  const rows = await deps.db
    .select()
    .from(parameter)
    .where(storeId ? eq(parameter.storeId, storeId) : isNull(parameter.storeId));
  const overrides: Partial<Record<ParamKey, unknown>> = {};
  for (const r of rows) overrides[r.key as ParamKey] = r.value;
  return resolveParams(overrides);
}


const audit = (deps: AppDeps, e: AuditEntry) => auditDb(deps.db, e);

const ParamsPath = z.object({ store_id: z.uuid() });
const ParamsBody = z.object({ key: z.enum(Object.keys(DEFAULT_PARAMS) as [ParamKey, ...ParamKey[]]), value: z.unknown(), reason: z.string().min(1).max(200) });

export async function registerBackoffice(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['console'];
  const sec = [{ bearer: [] }];

  // ---- пульт старшего смены (ТЗ §9) ----
  r.get('/console/stores/:store_id/orders', { schema: { tags, security: sec, params: ConsoleStoreParams, response: { 200: ConsoleOrdersView } } }, async (req) => {
    requireStaff(req.principal, 'shift_lead.console', req.params.store_id);
    return consoleOrders(deps, req.params.store_id);
  });
  r.get('/console/stores/:store_id/couriers', { schema: { tags, security: sec, params: ConsoleStoreParams, response: { 200: ConsoleCouriersView } } }, async (req) => {
    requireStaff(req.principal, 'shift_lead.console', req.params.store_id);
    return consoleCouriers(deps, req.params.store_id);
  });
  r.post('/console/stores/:store_id/orders/:id/assign', { schema: { tags, security: sec, params: ConsoleOrderParams, body: ManualAssignRequest, response: { 200: DeliveryTaskView } } }, async (req) => {
    const me = requireStaff(req.principal, 'dispatch.manual_assign', req.params.store_id);
    const view = await manualAssign(deps, me, req.params.id, req.body.courier_id, req.body.reason);
    await audit(deps, { actorType: 'staff', actorId: me.staff_id, action: 'dispatch.manual_assign', objectType: 'order', objectId: req.params.id, after: { courier_id: req.body.courier_id }, reason: req.body.reason, storeId: req.params.store_id });
    return view;
  });
  r.post('/console/stores/:store_id/orders/:id/cancel', { schema: { tags, security: sec, params: ConsoleOrderParams, body: StaffCancelRequest } }, async (req) => {
    const me = requireStaff(req.principal, 'orders.cancel_after_start', req.params.store_id);
    const res = await cancelByStaff(deps, me, req.params.id, req.body.reason);
    await audit(deps, { actorType: 'staff', actorId: me.staff_id, action: 'order.cancel', objectType: 'order', objectId: req.params.id, after: res, reason: req.body.reason, storeId: req.params.store_id });
    return res;
  });
  r.post('/console/stores/:store_id/orders/:id/returned', { schema: { tags, security: sec, params: ConsoleOrderParams, body: ReturnedRequest } }, async (req) => {
    const me = requireStaff(req.principal, 'shift_lead.console', req.params.store_id);
    const res = await markReturned(deps, me, req.params.id, req.body.comment);
    await audit(deps, { actorType: 'staff', actorId: me.staff_id, action: 'order.returned', objectType: 'order', objectId: req.params.id, after: res, storeId: req.params.store_id });
    return res;
  });
  r.post('/console/stores/:store_id/orders/:id/refund', { schema: { tags, security: sec, params: ConsoleOrderParams, body: RefundRequest, response: { 200: RefundView } } }, async (req) => {
    // до лимита — старший смены, управляющий, финансист; выше — только управляющий и финансист (ТЗ §9)
    const perms = req.body.amount_dirams > DEFAULT_PARAMS.REFUND_LIMIT_DIRAMS ? (['payments.refund.over_limit'] as const) : (['payments.refund.under_limit'] as const);
    const me = requireStaffAny(req.principal, [...perms], req.params.store_id);
    const res = await refund(deps, req.params.id, req.body.amount_dirams, me.staff_id, req.body.reason);
    await audit(deps, { actorType: 'staff', actorId: me.staff_id, action: 'payment.refund', objectType: 'order', objectId: req.params.id, after: res, reason: req.body.reason, storeId: req.params.store_id });
    return res;
  });

  r.get('/backoffice/stores/:store_id/params', { schema: { tags: ['backoffice'], security: [{ bearer: [] }], params: ParamsPath } }, async (req) => {
    requireStaffAny(req.principal, ['shift_lead.console', 'params.write'], req.params.store_id);
    return getParams(deps, req.params.store_id);
  });

  r.put(
    '/backoffice/stores/:store_id/params',
    { schema: { tags: ['backoffice'], security: [{ bearer: [] }], params: ParamsPath, body: ParamsBody } },
    async (req) => {
      const me = requireStaff(req.principal, 'params.write', req.params.store_id);
      const before = await getParams(deps, req.params.store_id);
      if (typeof req.body.value !== typeof DEFAULT_PARAMS[req.body.key]) {
        return { error: { code: 'VALIDATION', message: `Тип значения ${req.body.key} должен быть ${typeof DEFAULT_PARAMS[req.body.key]}` } };
      }
      await deps.db
        .insert(parameter)
        .values({ storeId: req.params.store_id, key: req.body.key, value: req.body.value, editedBy: me.staff_id })
        .onConflictDoUpdate({ target: [parameter.storeId, parameter.key], set: { value: req.body.value, editedBy: me.staff_id, updatedAt: deps.clock.now() } });
      await audit(deps, {
        actorType: 'staff',
        actorId: me.staff_id,
        action: 'params.set',
        objectType: 'parameter',
        objectId: `${req.params.store_id}:${req.body.key}`,
        before: before[req.body.key],
        after: req.body.value,
        reason: req.body.reason,
        storeId: req.params.store_id,
      });
      return getParams(deps, req.params.store_id);
    },
  );

  r.get('/backoffice/audit', { schema: { tags: ['backoffice'], security: [{ bearer: [] }], querystring: z.object({ object_type: z.string().optional(), object_id: z.string().optional() }) } }, async (req) => {
    const me = requireStaff(req.principal, 'audit.read');
    const { object_type, object_id } = req.query;
    return deps.db
      .select()
      .from(auditLog)
      // сотрудник точки видит журнал только своей точки (ТЗ §9)
      .where(
        and(
          object_type ? eq(auditLog.objectType, object_type) : undefined,
          object_id ? eq(auditLog.objectId, object_id) : undefined,
          me.store_id ? eq(auditLog.storeId, me.store_id) : undefined,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(200);
  });
}
