import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { createDb, type Db } from './shared/db/client.js';
import { AppError } from './shared/errors/index.js';
import { loggerOptions } from './shared/logger.js';
import { registerMetrics } from './shared/metrics.js';
import { TokenService } from './shared/auth/index.js';
import { authPlugin } from './shared/auth/plugin.js';
import { idempotencyPlugin } from './shared/idempotency/plugin.js';
import { systemClock, type Clock } from './shared/time.js';
import { StubWalletAdapter } from './modules/payments/stub-adapter.js';
import type { WalletAdapter } from './modules/payments/adapter.js';
import { registerCatalog } from './modules/catalog/index.js';
import { registerOrders } from './modules/orders/index.js';
import { registerCustomers } from './modules/customers/index.js';
import { registerBackoffice, registerReports } from './modules/backoffice/index.js';
import { registerCatalogAdmin, registerCatalogImport } from './modules/catalog/index.js';
import { registerPromoAdmin } from './modules/promo/index.js';
import { isStaffActive, registerStaffAdmin } from './modules/customers/index.js';
import { registerWmsAdmin } from './modules/wms/index.js';
import { registerCourierPlan } from './modules/dispatch/index.js';
import { registerRealtime } from './modules/realtime/index.js';
import { registerWms } from './modules/wms/index.js';
import { registerKds } from './modules/kds/index.js';
import { registerDispatch } from './modules/dispatch/index.js';

/** Зависимости, которые модули получают извне. Модули не создают их сами. */
export type AppDeps = {
  config: Config;
  db: Db;
  clock: Clock;
  tokens: TokenService;
  wallet: WalletAdapter;
};

export function createDeps(config: Config, over: Partial<AppDeps> = {}): AppDeps & { close: () => Promise<void> } {
  const { db, close } = over.db ? { db: over.db, close: async () => {} } : createDb(config.DATABASE_URL);
  const clock = over.clock ?? systemClock;
  return {
    config,
    db,
    clock,
    tokens: over.tokens ?? new TokenService(config.JWT_SECRET),
    wallet: over.wallet ?? new StubWalletAdapter(clock),
    close,
  };
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: loggerOptions(deps.config.LOG_LEVEL, deps.config.NODE_ENV === 'development'),
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdLogLabel: 'request_id',
    disableRequestLogging: deps.config.NODE_ENV === 'test',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Dark API — Lablabu + Sor Box', version: '0.1.0', description: 'Контракт генерируется из zod-схем @dark/contracts.' },
      servers: [{ url: '/api/v1' }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(websocket, { options: { maxPayload: 1024 } });

  await app.register(authPlugin, { tokens: deps.tokens });
  // Заблокированный сотрудник теряет доступ сразу, а не по истечении токена
  app.addHook('onRequest', async (req) => {
    const p = req.principal;
    if (p?.kind === 'staff' && !(await isStaffActive(deps, p.staff_id))) throw new AppError('UNAUTHORIZED', 'Сотрудник заблокирован');
  });

  await app.register(idempotencyPlugin, { db: deps.db });

  // Единый формат ошибки (ТЗ §4)
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return reply.status(err.status).send(err.toJSON());
    }
    if ('validation' in err && (err.validation || err.code === 'FST_ERR_VALIDATION')) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Некорректный запрос', details: { issues: err.validation } } });
    }
    if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'VALIDATION', message: err.message } });
    }
    req.log.error({ err }, 'необработанная ошибка');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка' } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Маршрут ${req.method} ${req.url} не найден` } }),
  );

  app.get('/health', { config: { idempotency: false } }, async () => ({ ok: true, at: deps.clock.now().toISOString() }));
  registerMetrics(app, deps.db, deps.config.METRICS_TOKEN);

  await app.register(
    async (api) => {
      await registerCustomers(api, deps);
      await registerCatalog(api, deps);
      await registerOrders(api, deps);
      await registerWms(api, deps);
      await registerKds(api, deps);
      await registerDispatch(api, deps);
      await registerBackoffice(api, deps);
      // админка
      await registerCatalogAdmin(api, deps);
      await registerCatalogImport(api, deps);
      await registerPromoAdmin(api, deps);
      await registerStaffAdmin(api, deps);
      await registerWmsAdmin(api, deps);
      await registerCourierPlan(api, deps);
      await registerReports(api, deps);
      await registerRealtime(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
