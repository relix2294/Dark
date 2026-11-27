import type { FastifyBaseLogger } from 'fastify';
import type { OutboxRelay } from '../../shared/events/outbox.js';

/**
 * Модуль notify: подписчик outbox-событий → пуши / SMS / внутренние оповещения (ТЗ §10).
 * Этап 0: только лог. Транспорты (пуш DC Next, SMS-шлюз) подключаются сюда, не в модули-источники.
 */
export function registerNotifySubscribers(relay: OutboxRelay, log: FastifyBaseLogger) {
  relay.on('order.status_changed', async (e) => {
    log.info({ order_id: e.aggregateId, ...e.payload }, 'notify: статус заказа');
  });
  relay.on('payment.failed', async (e) => {
    log.warn({ payment_id: e.aggregateId, ...e.payload }, 'notify: оплата не прошла');
  });
  relay.on('dispatch.no_courier', async (e) => {
    log.warn({ ...e.payload }, 'notify: заказ ждёт курьера — старшему смены');
  });
}
