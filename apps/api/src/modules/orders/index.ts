import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CancelOrderRequest, CartRequest, CartResponse, CreateOrderRequest, OrderIdParams, OrderView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { requireCustomer } from '../../shared/auth/index.js';
import { cancelByCustomer, createOrder, getOrderView, quoteCart } from './service.js';
import { openOrderStream } from './stream.js';

export { transition, cancelByStaff, markPaymentFailed, consoleOrders } from './service.js';
export { orderMachine, ACTIVE_STATUSES } from './state-machine.js';
export { getItemsWithProducts, markItemPicked, markItemMissing, addReplacementItem, recalcTotals, pendingItemIds } from './items.js';

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

  r.get('/orders/:id', { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, response: { 200: OrderView } } }, async (req) =>
    getOrderView(deps, req.params.id, requireCustomer(req.principal)),
  );

  r.post(
    '/orders/:id/cancel',
    { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, body: CancelOrderRequest, response: { 200: OrderView } } },
    async (req) => cancelByCustomer(deps, requireCustomer(req.principal), req.params.id, req.body.reason),
  );

  /** SSE: смена статуса и позиция курьера раз в 5 с (ТЗ §4). */
  r.get('/orders/:id/stream', { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams } }, async (req, reply) =>
    openOrderStream(deps, req, reply, req.params.id),
  );
}
