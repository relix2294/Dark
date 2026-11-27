import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app.js';
import { requireCustomer } from '../../shared/auth/index.js';
import { getOrderView } from './service.js';

/**
 * SSE первого этапа: опрос БД раз в 5 с и отправка при изменении статуса. Этап 2 — подписка на
 * outbox-события вместо опроса (ТЗ §1 допускает опрос как запасной вариант).
 */
export async function openOrderStream(deps: AppDeps, req: FastifyRequest, reply: FastifyReply, orderId: string) {
  const me = requireCustomer(req.principal);
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let last = '';
  const send = async () => {
    try {
      const view = await getOrderView(deps, orderId, me);
      const key = `${view.status}:${JSON.stringify(view.courier)}`;
      if (key !== last) {
        last = key;
        reply.raw.write(`event: order\ndata: ${JSON.stringify(view)}\n\n`);
      } else {
        reply.raw.write(`: ping\n\n`);
      }
    } catch (err) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
      stop();
    }
  };
  const timer = setInterval(() => void send(), 5000);
  const stop = () => {
    clearInterval(timer);
    reply.raw.end();
  };
  req.raw.on('close', stop);
  await send();
  return reply;
}
