import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { auditLog, parameter } from '../../shared/db/schema/index.js';
import { requireStaff } from '../../shared/auth/index.js';
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

export async function audit(
  deps: AppDeps,
  entry: { actorType: string; actorId: string | null; action: string; objectType: string; objectId: string; before?: unknown; after?: unknown; reason?: string; storeId?: string | null },
) {
  await deps.db.insert(auditLog).values({ ...entry, before: entry.before ?? null, after: entry.after ?? null, reason: entry.reason ?? null, storeId: entry.storeId ?? null });
}

const ParamsPath = z.object({ store_id: z.uuid() });
const ParamsBody = z.object({ key: z.enum(Object.keys(DEFAULT_PARAMS) as [ParamKey, ...ParamKey[]]), value: z.unknown(), reason: z.string().min(1).max(200) });

export async function registerBackoffice(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/backoffice/stores/:store_id/params', { schema: { tags: ['backoffice'], security: [{ bearer: [] }], params: ParamsPath } }, async (req) => {
    requireStaff(req.principal, 'shift_lead.console', req.params.store_id);
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
    requireStaff(req.principal, 'shift_lead.console');
    const { object_type, object_id } = req.query;
    return deps.db
      .select()
      .from(auditLog)
      .where(and(object_type ? eq(auditLog.objectType, object_type) : undefined, object_id ? eq(auditLog.objectId, object_id) : undefined))
      .orderBy(auditLog.createdAt)
      .limit(200);
  });
}
