/**
 * Realtime для экранов персонала (ТЗ §1): события outbox → Postgres NOTIFY → каждый инстанс API → WebSocket.
 * Через NOTIFY, а не в памяти процесса: при нескольких инстансах событие доходит до сокетов на любом из них.
 *
 * Плагин @fastify/websocket регистрируется на корне приложения (app.ts).
 * Клиент: GET /api/v1/ws?token=<JWT персонала>[&store_id=…] (браузер не умеет заголовки у WebSocket).
 * Сообщение: {"topic","aggregate_type","aggregate_id","store_id"} — сигнал «обнови данные», не сами данные:
 * клиент перечитывает нужное через REST, права проверяются как обычно.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import type { AppDeps } from '../../app.js';
import type { Db } from '../../shared/db/client.js';
import { courier, deliveryTask, kdsItem, order, payment, stockLot } from '../../shared/db/schema/index.js';
import type { OutboxRelay } from '../../shared/events/outbox.js';
import { hasPermission } from '../../shared/auth/index.js';
import { isStaffActive } from '../customers/index.js';
import { addMetricsProvider } from '../../shared/metrics.js';

export const CHANNEL = 'dark_events';

export type RealtimeMessage = { topic: string; aggregate_type: string; aggregate_id: string; store_id: string | null };

/** Точка события: по полю payload.store_id или по агрегату (только чтение). */
async function storeOf(db: Db, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<string | null> {
  if (typeof payload['store_id'] === 'string') return payload['store_id'];
  const one = async (q: Promise<{ s: string | null }[]>) => (await q)[0]?.s ?? null;
  switch (aggregateType) {
    case 'order':
      return one(db.select({ s: order.storeId }).from(order).where(eq(order.id, aggregateId)));
    case 'payment':
      return one(db.select({ s: order.storeId }).from(payment).innerJoin(order, eq(order.id, payment.orderId)).where(eq(payment.id, aggregateId)));
    case 'delivery_task':
      return one(db.select({ s: deliveryTask.storeId }).from(deliveryTask).where(eq(deliveryTask.id, aggregateId)));
    case 'courier':
      return one(db.select({ s: courier.currentStoreId }).from(courier).where(eq(courier.id, aggregateId)));
    case 'kds_item':
      return one(db.select({ s: kdsItem.storeId }).from(kdsItem).where(eq(kdsItem.id, aggregateId)));
    case 'stock_lot':
      return one(db.select({ s: stockLot.storeId }).from(stockLot).where(eq(stockLot.id, aggregateId)));
    default:
      return null;
  }
}

/** Подписчик outbox: каждое событие → NOTIFY. Вызывается из воркера relay. */
export function registerRealtimeSubscriber(relay: OutboxRelay, db: Db) {
  relay.on('*', async (e) => {
    const msg: RealtimeMessage = {
      topic: e.topic,
      aggregate_type: e.aggregateType,
      aggregate_id: e.aggregateId,
      store_id: await storeOf(db, e.aggregateType, e.aggregateId, e.payload),
    };
    await db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(msg)})`);
  });
}

type Client = { ws: WebSocket; storeId: string | null; role: string };

export async function registerRealtime(app: FastifyInstance, deps: AppDeps) {
  const clients = new Set<Client>();
  // Терминал или экран кухни не на связи (ТЗ §10): число открытых сокетов по точке и роли
  addMetricsProvider(() => {
    const counts = new Map<string, number>();
    for (const c of clients) {
      const k = `${c.storeId ?? 'all'}|${c.role}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [
      '# HELP dark_ws_clients Открытые WebSocket экранов персонала',
      '# TYPE dark_ws_clients gauge',
      ...[...counts].map(([k, n]) => {
        const [store, role] = k.split('|');
        return `dark_ws_clients{store_id="${store}",role="${role}"} ${n}`;
      }),
    ];
  });

  // Отдельное соединение под LISTEN: переподключение при обрыве
  let listener: pg.Client | null = null;
  let closing = false;
  const connect = async () => {
    if (closing) return;
    const c = new pg.Client({ connectionString: deps.config.DATABASE_URL });
    c.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      const msg = JSON.parse(n.payload) as RealtimeMessage;
      for (const cl of clients) {
        if (cl.storeId === null || msg.store_id === null || cl.storeId === msg.store_id) {
          if (cl.ws.readyState === cl.ws.OPEN) cl.ws.send(n.payload);
        }
      }
    });
    c.on('error', (err) => {
      app.log.warn({ err }, 'realtime: LISTEN оборвался, переподключение через 2 с');
      listener = null;
      setTimeout(() => void connect(), 2000);
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    listener = c;
  };
  await connect();
  app.addHook('onClose', async () => {
    closing = true;
    for (const cl of clients) cl.ws.close(1001, 'сервер останавливается');
    await listener?.end().catch(() => undefined);
  });

  app.get('/ws', { websocket: true, config: { idempotency: false } }, async (socket, req) => {
    const q = req.query as { token?: string; store_id?: string };
    try {
      const p = await deps.tokens.verify(q.token ?? '');
      const allowed = p.kind === 'staff' && (hasPermission(p.role, 'shift_lead.console') || ['picker', 'cook', 'courier'].includes(p.role));
      if (!allowed || p.kind !== 'staff' || !(await isStaffActive(deps, p.staff_id))) {
        socket.close(4403, 'нет прав');
        return;
      }
      // сотрудник точки — только своя точка; admin/finance — любая выбранная или все
      const storeId = p.store_id ?? q.store_id ?? null;
      const cl: Client = { ws: socket, storeId, role: p.role };
      clients.add(cl);
      socket.on('close', () => clients.delete(cl));
      socket.send(JSON.stringify({ topic: 'hello', aggregate_type: 'system', aggregate_id: '', store_id: storeId }));
    } catch {
      socket.close(4401, 'нужен вход');
    }
  });

  return { clients: () => clients.size };
}
