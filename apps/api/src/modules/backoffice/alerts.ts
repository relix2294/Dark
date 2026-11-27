import { sql } from 'drizzle-orm';
import type { Db } from '../../shared/db/client.js';

/** Какие события попадают на пульт старшего смены и с каким уровнем. */
export const ALERT_TOPICS = [
  'dispatch.no_courier',
  'kds.item_late',
  'stock.out',
  'stock.low',
  'stock.write_off_requested',
  'payment.failed',
  'payment.hold_expiring',
] as const;
type AlertTopic = (typeof ALERT_TOPICS)[number];
type Level = 'critical' | 'warning' | 'info';

type Row = { id: string; topic: AlertTopic; aggregate_id: string; payload: Record<string, unknown>; created_at: Date; order_id: string | null; order_number: string | null };

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const hhmm = (iso: unknown) =>
  new Date(String(iso)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dushanbe' });

/** Человеческий текст тревоги. Номер заказа — если событие о заказе. */
export function describeAlert(topic: AlertTopic, p: Record<string, unknown>, orderNumber: string | null): { level: Level; text: string } {
  const ord = orderNumber ? `Заказ ${orderNumber}` : 'Заказ';
  switch (topic) {
    case 'dispatch.no_courier':
      return { level: p.level === 'alert' ? 'critical' : 'warning', text: `${ord} ждёт курьера ${n(p.waiting_min)} мин` };
    case 'kds.item_late':
      return { level: 'warning', text: `${ord}: блюдо готово с опозданием ${Math.max(1, Math.round(n(p.late_sec) / 60))} мин` };
    case 'stock.out':
      return { level: 'critical', text: `Закончилось: ${String(p.name ?? 'товар')}` };
    case 'stock.low':
      return { level: 'warning', text: `Мало: ${String(p.name ?? 'товар')} — осталось ${n(p.available)} ${String(p.unit ?? '')}`.trim() };
    case 'stock.write_off_requested':
      return { level: 'info', text: `Запрос на списание: ${n(p.qty)} — ${String(p.reason ?? '')}`.trim() };
    case 'payment.failed':
      return { level: 'critical', text: `${ord}: оплата не прошла${p.reason ? ` (${String(p.reason)})` : ''}` };
    case 'payment.hold_expiring':
      return { level: 'warning', text: `${ord}: блокировка оплаты истекает в ${hhmm(p.expires_at)}` };
  }
}

/**
 * Лента тревог точки за последние часы, новые сверху. Точка — из payload.store_id; у старых событий
 * без него — через заказ (payload.order_id).
 */
export async function storeAlerts(db: Db, storeId: string, hours: number, limit = 100) {
  const topics = sql.join(ALERT_TOPICS.map((t) => sql`${t}`), sql`, `);
  const res = await db.execute<Row>(sql`
    select e.id, e.topic, e.aggregate_id, e.payload, e.created_at, o.id order_id, o.number order_number
    from outbox e
    left join "order" o on o.id::text = coalesce(e.payload->>'order_id', case when e.aggregate_type = 'order' then e.aggregate_id end)
    where e.topic in (${topics})
      and e.created_at > now() - make_interval(hours => ${hours})
      and coalesce(e.payload->>'store_id', o.store_id::text) = ${storeId}
    order by e.created_at desc
    limit ${limit}`);
  return res.rows.map((r) => {
    const d = describeAlert(r.topic, r.payload, r.order_number);
    return { id: r.id, topic: r.topic, level: d.level, text: d.text, order_id: r.order_id, order_number: r.order_number, created_at: new Date(r.created_at).toISOString() };
  });
}
