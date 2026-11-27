import fp from 'fastify-plugin';
import type { Principal } from '@dark/contracts';
import type { TokenService } from './index.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | undefined;
  }
}

/** Разбирает Authorization: Bearer <jwt>. Отсутствие токена — не ошибка; проверка прав — в обработчике. */
export const authPlugin = fp<{ tokens: TokenService }>(async (app, { tokens }) => {
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return;
    req.principal = await tokens.verify(h.slice(7));
  });
});
