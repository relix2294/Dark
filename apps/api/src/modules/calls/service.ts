import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { CustomerPrincipal, StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { callAttempt, callSession, courier, customer, deliveryTask, order, userStaff } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { eventTime } from '../../shared/event-time.js';

/** Связка живёт не дольше 4 часов — доставка столько не идёт; закрытие по факту — раньше. */
const SESSION_TTL_MS = 4 * 3600_000;
/** После доставки клиент ещё полчаса может перезвонить курьеру (забыл пакет, вопрос по заказу). */
const GRACE_AFTER_FINISH_MS = 30 * 60_000;
/** Задание, в котором курьер уже знает адрес и может звонить. */
const CALLABLE_TASK = ['accepted', 'at_store', 'picked_up', 'delivering'] as const;
const FINAL_ORDER = ['delivered', 'returned', 'cancelled', 'payment_failed'] as const;

type Session = typeof callSession.$inferSelect;

/** Активная связка заказа с нужным курьером; нет — создаётся у провайдера. Другой курьер — старая закрывается. */
async function ensureSession(deps: AppDeps, orderId: string, courierId: string): Promise<Session> {
  const [cur] = await deps.db.select().from(callSession).where(and(eq(callSession.orderId, orderId), isNull(callSession.closedAt)));
  if (cur && cur.courierId === courierId && cur.expiresAt > deps.clock.now()) return cur;
  if (cur) await close(deps, cur);

  const [row] = await deps.db
    .select({ customerPhone: customer.phone, courierPhone: userStaff.phone, number: order.number })
    .from(order)
    .innerJoin(customer, eq(customer.id, order.customerId))
    .innerJoin(courier, eq(courier.id, courierId))
    .innerJoin(userStaff, eq(userStaff.id, courier.staffId))
    .where(eq(order.id, orderId));
  if (!row?.customerPhone) throw new AppError('CALL_UNAVAILABLE', 'Номер клиента недоступен — напишите старшему смены');
  const res = await deps.calls.bind({ courierPhone: row.courierPhone, customerPhone: row.customerPhone, ttlSec: SESSION_TTL_MS / 1000, reference: `${orderId}:${courierId}` });
  if (!res.ok) throw new AppError('CALL_UNAVAILABLE', 'Звонок сейчас недоступен — попробуйте ещё раз', { provider: deps.calls.name, message: res.message });
  const [created] = await deps.db
    .insert(callSession)
    .values({
      orderId,
      courierId,
      provider: deps.calls.name,
      providerRef: res.providerRef,
      numberForCourier: res.numberForCourier,
      numberForCustomer: res.numberForCustomer,
      expiresAt: new Date(deps.clock.now().getTime() + SESSION_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // параллельный запрос успел создать связку — берём её, свою снимаем
  await deps.calls.unbind(res.providerRef).catch(() => undefined);
  const [winner] = await deps.db.select().from(callSession).where(and(eq(callSession.orderId, orderId), isNull(callSession.closedAt)));
  return winner!;
}

async function close(deps: AppDeps, s: Session) {
  await deps.calls.unbind(s.providerRef).catch(() => undefined); // провайдер сам истечёт по ttl
  await deps.db.update(callSession).set({ closedAt: deps.clock.now() }).where(eq(callSession.id, s.id));
}

/** Курьер звонит клиенту: только по заказу своего текущего задания. Нажатие пишется временем события. */
export async function courierDial(deps: AppDeps, me: StaffPrincipal, orderId: string, rawAt?: string) {
  const [t] = await deps.db
    .select({ courierId: deliveryTask.courierId })
    .from(deliveryTask)
    .innerJoin(courier, eq(courier.id, deliveryTask.courierId))
    .where(and(eq(courier.staffId, me.staff_id), inArray(deliveryTask.status, [...CALLABLE_TASK]), sql`${orderId} = any(${deliveryTask.orderIds})`));
  if (!t) throw notFound('Задание с этим заказом', orderId);
  const at = eventTime(deps.clock.now(), rawAt);
  const s = await ensureSession(deps, orderId, t.courierId);
  await deps.db.insert(callAttempt).values({ orderId, fromRole: 'courier', at });
  return { dial: s.numberForCourier };
}

/** Клиент звонит курьеру: когда курьер назначен и заказ ещё не закрыт (плюс полчаса после доставки). */
export async function customerDial(deps: AppDeps, me: CustomerPrincipal, orderId: string) {
  const [o] = await deps.db.select().from(order).where(and(eq(order.id, orderId), eq(order.customerId, me.customer_id)));
  if (!o) throw notFound('Заказ', orderId);
  const [t] = await deps.db
    .select({ courierId: deliveryTask.courierId })
    .from(deliveryTask)
    .where(and(inArray(deliveryTask.status, [...CALLABLE_TASK, 'done']), sql`${orderId} = any(${deliveryTask.orderIds})`))
    .orderBy(sql`${deliveryTask.assignedAt} desc`)
    .limit(1);
  const recentlyDelivered = o.status === 'delivered' && o.deliveredAt && deps.clock.now().getTime() - o.deliveredAt.getTime() < GRACE_AFTER_FINISH_MS;
  if (!t || !(['ready', 'on_the_way', 'returning'].includes(o.status) || recentlyDelivered)) throw new AppError('INVALID_TRANSITION', 'Курьер ещё не назначен');
  const s = await ensureSession(deps, orderId, t.courierId);
  await deps.db.insert(callAttempt).values({ orderId, fromRole: 'customer', at: deps.clock.now() });
  return { dial: s.numberForCustomer };
}

/** Сколько раз курьер звонил клиенту и когда впервые — для «клиент не вышел» (ТЗ §11). */
export async function courierCallStats(tx: Tx, orderId: string) {
  const rows = await tx
    .select({ at: callAttempt.at })
    .from(callAttempt)
    .where(and(eq(callAttempt.orderId, orderId), eq(callAttempt.fromRole, 'courier')))
    .orderBy(asc(callAttempt.at));
  return { count: rows.length, firstAt: rows[0]?.at ?? null };
}

/** После забора пакетов — связки заранее: курьер сможет позвонить и без связи с нашим сервером. */
export async function openCallSessions(deps: AppDeps, orderIds: string[], courierId: string) {
  for (const id of orderIds) {
    try {
      await ensureSession(deps, id, courierId);
    } catch {
      // нет номера клиента или провайдер недоступен — номер выдадим при первом нажатии «Позвонить»
    }
  }
}

/** Раз в минуту: закрыть связки истёкшие и по закрытым заказам (после получаса на «перезвонить»). */
export async function closeFinishedSessions(deps: AppDeps) {
  const now = deps.clock.now();
  const done = await deps.db
    .select({ s: callSession })
    .from(callSession)
    .innerJoin(order, eq(order.id, callSession.orderId))
    .where(
      and(
        isNull(callSession.closedAt),
        or(
          lt(callSession.expiresAt, now),
          // доставленный — от времени доставки (на телефоне клиента это «полчаса на перезвонить»), прочие закрытые — от последнего изменения
          and(inArray(order.status, [...FINAL_ORDER]), lt(sql`coalesce(${order.deliveredAt}, ${order.updatedAt})`, new Date(now.getTime() - GRACE_AFTER_FINISH_MS))),
        ),
      ),
    );
  for (const { s } of done) await close(deps, s);
  return done.length;
}
