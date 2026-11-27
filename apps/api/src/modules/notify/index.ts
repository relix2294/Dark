/**
 * Модуль notify: уведомления клиенту (ТЗ §10) и служебные оповещения персоналу.
 * Модули-источники публикуют события в outbox и ничего не знают о каналах доставки.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotificationListView, NotificationReadRequest } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { OutboxRelay } from '../../shared/events/outbox.js';
import { requireCustomer } from '../../shared/auth/index.js';
import * as svc from './service.js';

export { StubChannel, type CustomerChannel } from './channel.js';
export { sendPending, smsFallback, detectDelays, markPushDelivered } from './service.js';

export function registerNotifySubscribers(relay: OutboxRelay, deps: AppDeps, log: FastifyBaseLogger) {
  relay.on('order.status_changed', async (e) => {
    await svc.onStatusChanged(deps, e.aggregateId, String(e.payload['to']));
  });
  relay.on('order.item_replaced', async (e) => {
    if (typeof e.payload['item_id'] === 'string') await svc.onItemChanged(deps, e.aggregateId, e.payload['item_id']);
  });
  relay.on('payment.refunded', async (e) => {
    await svc.onRefunded(deps, String(e.payload['order_id']), Number(e.payload['amount']), (e.payload['reason'] as string | undefined) ?? null, e.id);
  });
  // служебные — в лог (персонал видит их на пульте через realtime)
  relay.on('payment.failed', async (e) => log.warn({ payment_id: e.aggregateId, ...e.payload }, 'notify: оплата не прошла'));
  relay.on('payment.hold_expiring', async (e) => log.warn({ payment_id: e.aggregateId, ...e.payload }, 'notify: холд скоро истечёт — оператору'));
  relay.on('payment.reconcile_mismatch', async (e) => log.error({ payment_id: e.aggregateId, ...e.payload }, 'notify: расхождение с банком — финансисту'));
  relay.on('dispatch.no_courier', async (e) => log.warn({ ...e.payload }, 'notify: заказ ждёт курьера — старшему смены'));
}

export async function registerNotify(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['storefront'];
  const sec = [{ bearer: [] }];
  r.get('/notifications', { schema: { tags, security: sec, response: { 200: NotificationListView } } }, async (req) => svc.listForCustomer(deps, requireCustomer(req.principal).customer_id));
  r.post('/notifications/read', { schema: { tags, security: sec, body: NotificationReadRequest, response: { 200: NotificationListView } } }, async (req) =>
    svc.markRead(deps, requireCustomer(req.principal).customer_id, req.body.ids),
  );
}
