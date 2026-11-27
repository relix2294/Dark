import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { idempotencyKey } from '../db/schema/index.js';
import { AppError } from '../errors/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    idem?: { key: string; scope: string; hash: string };
  }
  interface FastifyContextConfig {
    /** Маршрут не требует Idempotency-Key (логин, телеметрия позиции). */
    idempotency?: false;
  }
}

function hashBody(req: FastifyRequest): string {
  return createHash('sha256').update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`).digest('hex');
}

function scopeOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) return `anon:${req.ip}`;
  return p.kind === 'staff' ? `staff:${p.staff_id}` : `customer:${p.customer_id}`;
}

/**
 * Каждый изменяющий запрос принимает Idempotency-Key; повтор с тем же ключом возвращает первый результат (ТЗ §1).
 * Ключ действует в рамках субъекта. Тот же ключ с другим телом — 409 IDEMPOTENCY_CONFLICT.
 * Параллельный повтор пока первый не завершён — 409 (клиент повторяет позже).
 */
export const idempotencyPlugin = fp<{ db: Db }>(async (app, { db }) => {
  // preValidation: ключ проверяется до валидации тела, чтобы запрос без ключа получал IDEMPOTENCY_KEY_REQUIRED
  app.addHook('preValidation', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING.has(req.method)) return;
    if (req.routeOptions.config.idempotency === false) return;
    if (req.url.startsWith('/docs') || req.url.startsWith('/health')) return;

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Заголовок Idempotency-Key обязателен (8–128 символов)');
    }
    const scope = scopeOf(req);
    const hash = hashBody(req);

    const [existing] = await db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.scope, scope), eq(idempotencyKey.key, key)));

    if (existing) {
      if (existing.requestHash !== hash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Этот Idempotency-Key уже использован с другим запросом');
      }
      if (!existing.completedAt) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Запрос с этим ключом ещё выполняется, повторите позже');
      }
      reply.header('idempotent-replayed', 'true');
      return reply.status(existing.responseStatus ?? 200).send(existing.responseBody);
    }

    try {
      await db.insert(idempotencyKey).values({ key, scope, requestHash: hash });
    } catch {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Запрос с этим ключом ещё выполняется, повторите позже');
    }
    req.idem = { key, scope, hash };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idem) return payload;
    const body = typeof payload === 'string' && payload.length ? safeJson(payload) : null;
    // 5xx не фиксируем: клиент имеет право повторить
    if (reply.statusCode >= 500) {
      await db.delete(idempotencyKey).where(and(eq(idempotencyKey.scope, req.idem.scope), eq(idempotencyKey.key, req.idem.key)));
      return payload;
    }
    await db
      .update(idempotencyKey)
      .set({ responseStatus: reply.statusCode, responseBody: body, completedAt: new Date() })
      .where(and(eq(idempotencyKey.scope, req.idem.scope), eq(idempotencyKey.key, req.idem.key)));
    return payload;
  });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
