import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CancelOrderRequest, CartRequest, CartResponse, CreateOrderRequest, OrderIdParams, OrderListView, OrderRatingView, OrderView, RateOrderRequest, RepeatOrderView } from '@dark/contracts';
import { rateOrder, repeatOrder } from './feedback.js';
import type { AppDeps } from '../../app.js';
import { requireCustomer } from '../../shared/auth/index.js';
import { cancelByCustomer, createOrder, getOrderView, listOrders, quoteCart } from './service.js';
import { openOrderStream } from './stream.js';

export { transition, cancelByStaff, markPaymentFailed, consoleOrders } from './service.js';
export { orderMachine, ACTIVE_STATUSES } from './state-machine.js';
export { getItemsWithProducts, markItemPicked, markItemMissing, addReplacementItem, recalcTotals, pendingItemIds, setCaptured, setPromisedAt, markAllItemsPicked } from './items.js';

export async function registerOrders(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.put('/cart', { schema: { tags: ['storefront'], security: [{ bearer: [] }], body: CartRequest, response: { 200: CartResponse } } }, async (req) =>
    quoteCart(deps, requireCustomer(req.principal), req.body),
  );

  r.post(
    '/orders',
    { schema: { tags: ['storefront'], security: [{ bearer: [] }], body: CreateOrderRequest, response: { 201: OrderView } } },
    async (req, reply) => {
      const view = await createOrder(deps, requireCustomer(req.principal), req.body);
      return reply.status(201).send(view);
    },
  );

  r.get('/orders', { schema: { tags: ['storefront'], security: [{ bearer: [] }], response: { 200: OrderListView } } }, async (req) => listOrders(deps, requireCustomer(req.principal)));

  r.get('/orders/:id', { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, response: { 200: OrderView } } }, async (req) =>
    getOrderView(deps, req.params.id, requireCustomer(req.principal)),
  );

  r.post(
    '/orders/:id/cancel',
    { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, body: CancelOrderRequest, response: { 200: OrderView } } },
    async (req) => cancelByCustomer(deps, requireCustomer(req.principal), req.params.id, req.body.reason),
  );

  /** Оценка после доставки (ТЗ §9). */
  r.post(
    '/orders/:id/rating',
    { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, body: RateOrderRequest, response: { 201: OrderRatingView } } },
    async (req, reply) => reply.status(201).send(await rateOrder(deps, requireCustomer(req.principal), req.params.id, req.body)),
  );

  /** Повторить заказ (ТЗ §9): корзина по текущему меню; витрина пересчитывает её через PUT /cart. */
  r.get('/orders/:id/repeat', { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, response: { 200: RepeatOrderView } } }, async (req) =>
    repeatOrder(deps, requireCustomer(req.principal), req.params.id),
  );

  /** SSE: смена статуса и позиция курьера раз в 5 с (ТЗ §4). */
  r.get('/orders/:id/stream', { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams } }, async (req, reply) =>
    openOrderStream(deps, req, reply, req.params.id),
  );
}
