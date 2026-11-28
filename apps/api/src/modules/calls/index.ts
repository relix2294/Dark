import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CallRequest, CallView, OrderIdParams } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { requireCustomer, requireStaff } from '../../shared/auth/index.js';
import { courierDial, customerDial } from './service.js';

export type { CallProxy } from './adapter.js';
export { StubCallProxy } from './stub.js';
export { closeFinishedSessions, courierCallStats, openCallSessions } from './service.js';

/**
 * Модуль calls: звонки курьер ↔ клиент через подменные номера (ТЗ §9). Ни одна сторона не видит настоящий номер.
 * «Позвонить» возвращает номер для набора; телефон звонит обычным звонком через провайдера.
 */
export async function registerCalls(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    '/courier/orders/:id/call',
    { schema: { tags: ['courier'], security: [{ bearer: [] }], params: OrderIdParams, body: CallRequest.nullish(), response: { 200: CallView } } },
    async (req) => courierDial(deps, requireStaff(req.principal, 'courier.app'), req.params.id, req.body?.at),
  );
  r.post(
    '/orders/:id/call-courier',
    { schema: { tags: ['storefront'], security: [{ bearer: [] }], params: OrderIdParams, response: { 200: CallView } } },
    async (req) => customerDial(deps, requireCustomer(req.principal), req.params.id),
  );
}
