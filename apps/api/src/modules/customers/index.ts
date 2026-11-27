import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/client.js';
import { AddressCreate, AddressListView, AddressView, AuthResponse, DcAuthRequest, StaffLoginRequest } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { address, customer, userStaff } from '../../shared/db/schema/index.js';
import { requireCustomer } from '../../shared/auth/index.js';
import { AppError } from '../../shared/errors/index.js';
import { hashPin, verifyPin } from '../../shared/auth/index.js';
import { audit } from '../../shared/audit.js';
import { lockedFor, recordFailure, resetPhone } from './login-guard.js';
export { purgeAttempts, resetPhone } from './login-guard.js';

const DUMMY_HASH = hashPin('000000');
export { registerStaffAdmin, isStaffActive } from './admin.js';

/**
 * Модуль customers: вход клиента (обмен токена DC Next) и вход персонала (телефон + PIN).
 * Публичный интерфейс для других модулей — только функции ниже, не таблицы.
 */
/** Заказ доставлен: счётчик заказов клиента и дата первого заказа (для отчётов и сегментов). */
export async function markCustomerDelivered(tx: Tx, customerId: string, at: Date) {
  await tx
    .update(customer)
    .set({ ordersCount: sql`${customer.ordersCount} + 1`, firstOrderAt: sql`coalesce(${customer.firstOrderAt}, ${at})` })
    .where(eq(customer.id, customerId));
}

export async function findCustomerById(deps: AppDeps, id: string) {
  const [c] = await deps.db.select().from(customer).where(eq(customer.id, id));
  return c ?? null;
}

/**
 * Проверка токена DC Next. Контракт банка не получен: пока принимаем токен вида `dc:<dc_user_id>`
 * (только не в production). Реальная проверка — за адаптером, как и платежи.
 */
async function verifyDcToken(deps: AppDeps, token: string): Promise<{ dcUserId: string; phoneMasked?: string; name?: string }> {
  if (deps.config.NODE_ENV !== 'production' && token.startsWith('dc:')) {
    return { dcUserId: token.slice(3) };
  }
  throw new AppError('UNAUTHORIZED', 'Токен DC Next не принят');
}

export async function registerCustomers(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/dc',
    {
      config: { idempotency: false },
      schema: { tags: ['auth'], body: DcAuthRequest, response: { 200: AuthResponse } },
    },
    async (req) => {
      const dc = await verifyDcToken(deps, req.body.dc_token);
      const [c] = await deps.db
        .insert(customer)
        .values({ dcUserId: dc.dcUserId, phoneMasked: dc.phoneMasked ?? null, name: dc.name ?? null })
        .onConflictDoUpdate({ target: customer.dcUserId, set: { updatedAt: deps.clock.now() } })
        .returning();
      const { token, expiresAt } = await deps.tokens.sign({ kind: 'customer', customer_id: c!.id, dc_user_id: c!.dcUserId });
      return { token, expires_at: expiresAt.toISOString() };
    },
  );

  r.post(
    '/auth/staff',
    {
      config: { idempotency: false },
      schema: { tags: ['auth'], body: StaffLoginRequest, response: { 200: AuthResponse } },
    },
    async (req, reply) => {
      const now = deps.clock.now();
      const { phone, pin } = req.body;
      const until = await lockedFor(deps.db, phone, req.ip, now);
      if (until) {
        reply.header('retry-after', Math.ceil((until.getTime() - now.getTime()) / 1000));
        throw new AppError('RATE_LIMITED', 'Слишком много неудачных попыток. Попробуйте позже или попросите управляющего сменить PIN', { until: until.toISOString() });
      }
      const [u] = await deps.db.select().from(userStaff).where(eq(userStaff.phone, phone));
      // PIN проверяется и для несуществующего телефона — по времени ответа не узнать, есть ли такой сотрудник
      const ok = verifyPin(pin, u?.pinHash ?? DUMMY_HASH) && !!u?.isActive;
      if (!u || !ok) {
        const { phoneLocked } = await recordFailure(deps.db, phone, req.ip, now);
        if (phoneLocked)
          await audit(deps.db, { actorType: 'system', actorId: null, action: 'auth.locked', objectType: 'user_staff', objectId: u?.id ?? phone, after: { ip: req.ip }, reason: 'перебор PIN', storeId: u?.storeId ?? null });
        throw new AppError('UNAUTHORIZED', 'Неверный телефон или PIN');
      }
      await resetPhone(deps.db, phone);
      const { token, expiresAt } = await deps.tokens.sign({ kind: 'staff', staff_id: u.id, role: u.role, store_id: u.storeId });
      return { token, expires_at: expiresAt.toISOString() };
    },
  );

  const toView = (a: typeof address.$inferSelect) => ({
    id: a.id,
    lat: a.lat,
    lon: a.lon,
    street: a.street,
    house: a.house,
    entrance: a.entrance,
    floor: a.floor,
    flat: a.flat,
    comment: a.comment,
  });

  r.get('/addresses', { schema: { tags: ['storefront'], security: [{ bearer: [] }], response: { 200: AddressListView } } }, async (req) => {
    const me = requireCustomer(req.principal);
    const rows = await deps.db.select().from(address).where(eq(address.customerId, me.customer_id)).orderBy(address.createdAt);
    return { addresses: rows.map(toView) };
  });

  r.post('/addresses', { schema: { tags: ['storefront'], security: [{ bearer: [] }], body: AddressCreate, response: { 201: AddressView } } }, async (req, reply) => {
    const me = requireCustomer(req.principal);
    const b = req.body;
    const [a] = await deps.db
      .insert(address)
      .values({ customerId: me.customer_id, lat: b.lat, lon: b.lon, street: b.street, house: b.house, entrance: b.entrance ?? null, floor: b.floor ?? null, flat: b.flat ?? null, comment: b.comment ?? null })
      .returning();
    return reply.status(201).send(toView(a!));
  });
}
