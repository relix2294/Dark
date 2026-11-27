import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { MoneyReport, ReportQuery, ReportSummary, StoreIdParams } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { requireStaff, requireStaffAny } from '../../shared/auth/index.js';

/**
 * Отчёты (ТЗ §9, §10): только чтение. Отчётам разрешено читать таблицы всех модулей —
 * это проекция данных, писать они ничего не пишут. Границы дат — по Asia/Dushanbe.
 */

const tags = ['reports'];
const sec = [{ bearer: [] }];
const TZ = 'Asia/Dushanbe';

export async function registerReports(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/reports/summary', { schema: { tags, security: sec, querystring: ReportQuery, response: { 200: ReportSummary } } }, async (req) => {
    const { store_id, from, to } = req.query;
    requireStaffAny(req.principal, ['finance.reports', 'shift_lead.console'], store_id);
    const range = sql`o.store_id = ${store_id} and (o.created_at at time zone ${TZ})::date between ${from}::date and ${to}::date`;
    const db = deps.db;

    const byStatus = await db.execute<{ status: string; n: number }>(sql`select o.status, count(*)::int n from "order" o where ${range} group by 1`);
    const byBrand = await db.execute<{ brand: 'LAB' | 'SOR'; orders: number; delivered: number; captured: number; on_time: number }>(sql`
      select o.brand,
        count(*)::int orders,
        count(*) filter (where o.status = 'delivered')::int delivered,
        coalesce(sum(o.captured_dirams) filter (where o.status in ('delivered','returned','cancelled')), 0)::int captured,
        count(*) filter (where o.status = 'delivered' and o.delivered_at <= o.promised_at)::int on_time
      from "order" o where ${range} group by 1 order by 1`);
    const [money] = (
      await db.execute<{ refunds: number; discounts: number }>(sql`
        select
          coalesce((select sum(p.refunded_dirams) from payment p join "order" o on o.id = p.order_id where ${range}), 0)::int refunds,
          coalesce((select sum(o.discount_dirams) from "order" o where ${range} and o.status = 'delivered'), 0)::int discounts`)
    ).rows;
    const [wo] = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int n from stock_move m
        where m.store_id = ${store_id} and m.type = 'write_off' and (m.created_at at time zone ${TZ})::date between ${from}::date and ${to}::date`)
    ).rows;
    const pickers = await db.execute<{ staff_id: string; name: string; tasks: number; avg_sec: number }>(sql`
      select t.picker_id staff_id, u.name, count(*)::int tasks, avg(extract(epoch from t.completed_at - t.started_at))::float avg_sec
      from pick_task t join user_staff u on u.id = t.picker_id
      where t.store_id = ${store_id} and t.status = 'done' and (t.started_at at time zone ${TZ})::date between ${from}::date and ${to}::date
      group by 1, 2 order by avg_sec`);
    const daily = await db.execute<{ date: string; orders: number; captured: number }>(sql`
      select to_char((o.created_at at time zone ${TZ})::date, 'YYYY-MM-DD') date, count(*)::int orders,
        coalesce(sum(o.captured_dirams), 0)::int captured
      from "order" o where ${range} group by 1 order by 1`);

    const [rating] = (
      await db.execute<{ n: number; avg: number | null; low: number }>(sql`
        select count(*)::int n, avg(r.score)::float avg, count(*) filter (where r.score <= 3)::int low
        from order_rating r join "order" o on o.id = r.order_id where ${range}`)
    ).rows;
    const totalPick = pickers.rows.reduce((a, p) => a + p.tasks, 0);
    return {
      orders_total: byStatus.rows.reduce((a, x) => a + x.n, 0),
      orders_by_status: Object.fromEntries(byStatus.rows.map((x) => [x.status, x.n])),
      by_brand: byBrand.rows.map((b) => ({
        brand: b.brand,
        orders: b.orders,
        delivered: b.delivered,
        captured_dirams: b.captured,
        avg_check_dirams: b.delivered ? Math.round(b.captured / b.delivered) : 0,
        on_time_pct: b.delivered ? Math.round((b.on_time / b.delivered) * 1000) / 10 : 0,
      })),
      refunds_dirams: money?.refunds ?? 0,
      discounts_dirams: money?.discounts ?? 0,
      write_offs: wo?.n ?? 0,
      avg_pick_sec: totalPick ? Math.round(pickers.rows.reduce((a, p) => a + p.avg_sec * p.tasks, 0) / totalPick) : null,
      pickers: pickers.rows.map((p) => ({ ...p, avg_sec: Math.round(p.avg_sec) })),
      rating: rating && rating.n ? { count: rating.n, avg: Math.round((rating.avg ?? 0) * 100) / 100, low: rating.low } : null,
      daily: daily.rows.map((d) => ({ date: d.date, orders: d.orders, captured_dirams: d.captured })),
    };
  });

  /** «Деньги» (ТЗ §5, §10): статусы платежей, зависшие *_pending старше 5 минут, неуспешные операции. */
  r.get('/admin/reports/money/:store_id', { schema: { tags, security: sec, params: StoreIdParams, response: { 200: MoneyReport } } }, async (req) => {
    const { store_id } = req.params;
    requireStaff(req.principal, 'finance.reports', store_id);
    const db = deps.db;
    const now = deps.clock.now();
    const byStatus = await db.execute<{ status: string; count: number; dirams: number }>(sql`
      select p.status, count(*)::int count, coalesce(sum(case when p.status in ('captured','partially_refunded','refunded') then p.captured_dirams else p.hold_dirams end), 0)::int dirams
      from payment p join "order" o on o.id = p.order_id where o.store_id = ${store_id} group by 1`);
    const pending = await db.execute<{ payment_id: string; order_id: string; status: string; since: Date; last_error: string | null }>(sql`
      select p.id payment_id, p.order_id, p.status, p.updated_at since, p.last_error
      from payment p join "order" o on o.id = p.order_id
      where o.store_id = ${store_id} and p.status::text like '%_pending' and p.updated_at < ${new Date(now.getTime() - 5 * 60_000)}
      order by p.updated_at limit 100`);
    const failed = await db.execute<{ payment_id: string; type: string; amount_dirams: number; key: string; at: Date }>(sql`
      select op.payment_id, op.type, op.amount_dirams, op.idempotency_key key, op.updated_at at
      from payment_op op join payment p on p.id = op.payment_id join "order" o on o.id = p.order_id
      where o.store_id = ${store_id} and (op.status = 'failed' or (op.status = 'pending' and op.provider_response is not null))
      order by op.updated_at desc limit 100`);
    return {
      payments_by_status: Object.fromEntries(byStatus.rows.map((x) => [x.status, { count: x.count, dirams: x.dirams }])),
      pending_over_5min: pending.rows.map((p) => ({ ...p, since: new Date(p.since).toISOString() })),
      failed_ops: failed.rows.map((f) => ({ ...f, at: new Date(f.at).toISOString() })),
    };
  });
}
