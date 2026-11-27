import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, sql } from 'drizzle-orm';
import { CourierPlanInput, CourierPlanQuery, CourierPlanView, StoreIdParams } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { courier, courierPlan } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { requireStaff } from '../../shared/auth/index.js';
import { DEFAULT_PARAMS } from '../../shared/params/index.js';

/** Курьер — расширение сотрудника с ролью courier. Создаётся при заведении/смене роли. */
export async function ensureCourier(tx: Tx, staffId: string, transport: 'foot' | 'bike' | 'moto', storeId: string | null) {
  await tx.insert(courier).values({ staffId, transport, currentStoreId: storeId }).onConflictDoNothing({ target: courier.staffId });
}

/**
 * Прогноз заказов по часам: среднее за те же дни недели последних 4 недель (Asia/Dushanbe).
 * Курьеров нужно = ceil(LAB / производительность + SOR / производительность), минимум LAB_RESERVE в часы работы.
 */
export async function forecast(tx: Tx, storeId: string, date: string) {
  const rows = await tx.execute<{ hour: number; brand: 'LAB' | 'SOR'; n: number }>(sql`
    with days as (
      select (${date}::date - (7 * w)) as d from generate_series(1, 4) w
    )
    select extract(hour from o.created_at at time zone 'Asia/Dushanbe')::int as hour, o.brand, (count(*)::numeric / 4)::float as n
    from "order" o
    where o.store_id = ${storeId}
      and (o.created_at at time zone 'Asia/Dushanbe')::date in (select d from days)
      and o.status not in ('payment_failed')
    group by 1, 2`);
  const perHour = DEFAULT_PARAMS.COURIER_ORDERS_PER_HOUR;
  const out = Array.from({ length: 24 }, (_, hour) => {
    const lab = Math.round(rows.rows.find((r) => r.hour === hour && r.brand === 'LAB')?.n ?? 0);
    const sor = Math.round(rows.rows.find((r) => r.hour === hour && r.brand === 'SOR')?.n ?? 0);
    const need = lab + sor === 0 ? 0 : Math.max(DEFAULT_PARAMS.LAB_RESERVE, Math.ceil((lab + sor) / perHour));
    return { hour, forecast_orders_lab: lab, forecast_orders_sor: sor, couriers_needed: need };
  });
  return out;
}

export async function registerCourierPlan(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['admin'];
  const sec = [{ bearer: [] }];

  r.get('/admin/stores/:store_id/courier-plan', { schema: { tags, security: sec, params: StoreIdParams, querystring: CourierPlanQuery, response: { 200: CourierPlanView } } }, async (req) => {
    requireStaff(req.principal, 'dispatch.plan', req.params.store_id);
    return deps.db.transaction(async (tx) => {
      const fc = await forecast(tx, req.params.store_id, req.query.date);
      const saved = await tx.select().from(courierPlan).where(and(eq(courierPlan.storeId, req.params.store_id), eq(courierPlan.date, req.query.date)));
      return {
        date: req.query.date,
        rows: fc.map((f) => ({ ...f, couriers_planned: saved.find((s) => s.hour === f.hour)?.couriersPlanned ?? 0 })),
      };
    });
  });

  r.put('/admin/stores/:store_id/courier-plan', { schema: { tags, security: sec, params: StoreIdParams, querystring: CourierPlanQuery, body: CourierPlanInput, response: { 200: CourierPlanView } } }, async (req) => {
    const me = requireStaff(req.principal, 'dispatch.plan', req.params.store_id);
    const { store_id } = req.params;
    const { date } = req.query;
    return deps.db.transaction(async (tx) => {
      const fc = await forecast(tx, store_id, date);
      for (const row of req.body.rows) {
        const f = fc[row.hour]!;
        const [ex] = await tx.select().from(courierPlan).where(and(eq(courierPlan.storeId, store_id), eq(courierPlan.date, date), eq(courierPlan.hour, row.hour)));
        const v = { forecastOrdersLab: f.forecast_orders_lab, forecastOrdersSor: f.forecast_orders_sor, couriersNeeded: f.couriers_needed, couriersPlanned: row.couriers_planned, editedBy: me.staff_id };
        if (ex) await tx.update(courierPlan).set(v).where(eq(courierPlan.id, ex.id));
        else await tx.insert(courierPlan).values({ storeId: store_id, date, hour: row.hour, ...v });
      }
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'courier_plan.set', objectType: 'courier_plan', objectId: `${store_id}:${date}`, after: req.body.rows, storeId: store_id });
      const saved = await tx.select().from(courierPlan).where(and(eq(courierPlan.storeId, store_id), eq(courierPlan.date, date)));
      return { date, rows: fc.map((f) => ({ ...f, couriers_planned: saved.find((s) => s.hour === f.hour)?.couriersPlanned ?? 0 })) };
    });
  });
}
