import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db/client.js';

/**
 * Метрики для тревог ТЗ §10 в формате Prometheus (text/plain 0.0.4).
 * HTTP-счётчики — в памяти процесса; состояние очередей и денег — запросом к БД при каждом снятии.
 * Пороги тревог задаются в системе мониторинга (deploy/alerts.yml), не в коде.
 */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];

type Hist = { buckets: number[]; sum: number; count: number };

/** Модули добавляют свои метрики сюда (shared не импортирует modules). Возвращают готовые строки экспозиции. */
const providers: (() => string[])[] = [];
export const addMetricsProvider = (fn: () => string[]) => void providers.push(fn);

export function registerMetrics(app: FastifyInstance, db: Db, token: string | undefined) {
  const requests = new Map<string, number>(); // route|method|class → count
  const latency = new Map<string, Hist>(); // route|method → histogram

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unknown';
    if (route === '/metrics' || route === '/health') return;
    const cls = `${Math.floor(reply.statusCode / 100)}xx`;
    const k = `${route}|${req.method}|${cls}`;
    requests.set(k, (requests.get(k) ?? 0) + 1);
    const lk = `${route}|${req.method}`;
    const h = latency.get(lk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    const sec = reply.elapsedTime / 1000;
    BUCKETS.forEach((b, i) => {
      if (sec <= b) h.buckets[i]!++;
    });
    h.sum += sec;
    h.count++;
    latency.set(lk, h);
  });

  app.get('/metrics', { config: { idempotency: false }, schema: { hide: true } }, async (req, reply) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.status(401).send('unauthorized');
    const lines: string[] = [];
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    lines.push('# HELP dark_http_requests_total HTTP-запросы по маршруту, методу и классу ответа', '# TYPE dark_http_requests_total counter');
    for (const [k, v] of requests) {
      const [route, method, cls] = k.split('|');
      lines.push(`dark_http_requests_total{route="${esc(route!)}",method="${method}",status="${cls}"} ${v}`);
    }
    lines.push('# HELP dark_http_request_duration_seconds Время ответа', '# TYPE dark_http_request_duration_seconds histogram');
    for (const [k, h] of latency) {
      const [route, method] = k.split('|');
      const l = `route="${esc(route!)}",method="${method}"`;
      BUCKETS.forEach((b, i) => lines.push(`dark_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      lines.push(`dark_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`);
      lines.push(`dark_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(4)}`, `dark_http_request_duration_seconds_count{${l}} ${h.count}`);
    }

    const [g] = (
      await db.execute<{ backlog: number; oldest: number | null; pending5: number; held_failed_10m: number; held_total_10m: number }>(sql`
        select
          (select count(*)::int from outbox where published_at is null) backlog,
          (select extract(epoch from now() - min(created_at))::float from outbox where published_at is null) oldest,
          (select count(*)::int from payment where status::text like '%_pending' and updated_at < now() - interval '5 minutes') pending5,
          (select count(*)::int from payment_op where type = 'hold' and status = 'failed' and updated_at > now() - interval '10 minutes') held_failed_10m,
          (select count(*)::int from payment_op where type = 'hold' and updated_at > now() - interval '10 minutes') held_total_10m`)
    ).rows;
    const stores = await db.execute<{ store_id: string; ready_wait_max: number | null; ready_no_courier: number }>(sql`
      select o.store_id,
        max(extract(epoch from now() - o.ready_at))::float ready_wait_max,
        count(*)::int ready_no_courier
      from "order" o
      where o.status = 'ready' and not exists (
        select 1 from delivery_task t where o.id = any(t.order_ids) and t.status in ('offered','accepted','at_store','picked_up','delivering'))
      group by o.store_id`);

    const gauge = (name: string, help: string, v: number | null | undefined, labels = '') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels ? `{${labels}}` : ''} ${v ?? 0}`);
    };
    gauge('dark_outbox_backlog', 'Неотправленные события outbox (тревога > 100)', g?.backlog);
    gauge('dark_outbox_oldest_seconds', 'Возраст самого старого неотправленного события (тревога > 60)', g?.oldest);
    gauge('dark_payments_pending_over_5m', 'Платежи в *_pending дольше 5 минут (тревога > 0)', g?.pending5);
    gauge('dark_holds_failed_10m', 'Отказы холда за 10 минут', g?.held_failed_10m);
    gauge('dark_holds_total_10m', 'Попытки холда за 10 минут', g?.held_total_10m);
    lines.push('# HELP dark_ready_without_courier_seconds Максимальное ожидание курьера готовым заказом', '# TYPE dark_ready_without_courier_seconds gauge');
    for (const s of stores.rows) lines.push(`dark_ready_without_courier_seconds{store_id="${s.store_id}"} ${Math.round(s.ready_wait_max ?? 0)}`);
    lines.push('# HELP dark_ready_without_courier Готовые заказы без курьера', '# TYPE dark_ready_without_courier gauge');
    for (const s of stores.rows) lines.push(`dark_ready_without_courier{store_id="${s.store_id}"} ${s.ready_no_courier}`);

    for (const p of providers) lines.push(...p());
    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });
}
