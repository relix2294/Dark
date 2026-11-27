import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import { customer, notification, order, orderItem } from '../../shared/db/schema/index.js';
import { courierForOrder } from '../dispatch/index.js';
import { SMS_FALLBACK, render, type Kind, type Msg } from './templates.js';

/**
 * Уведомления клиенту (ТЗ §10): событие → запись notification (ключ против дублей) → отправка пушем;
 * для «курьер выехал» и «отмены» — SMS, если пуш не доставлен за 30 с. Отправка отделена от события:
 * сбой канала не теряет уведомление, оно уйдёт на следующем проходе.
 */
export const SMS_AFTER_MS = 30_000;
export const DELAY_NOTIFY_MS = 5 * 60_000;

async function loadOrder(deps: AppDeps, orderId: string) {
  const [o] = await deps.db.select({ o: order, dc: customer.dcUserId }).from(order).innerJoin(customer, eq(customer.id, order.customerId)).where(eq(order.id, orderId));
  return o ?? null;
}

const orderUrl = (deps: AppDeps, orderId: string) => `${deps.config.PUBLIC_URL.replace(/\/$/, '')}/store/?order=${orderId}`;

/** Создать уведомление один раз на ключ. Возвращает true, если создано. */
export async function enqueueNotification(deps: AppDeps, o: { id: string; customerId: string }, kind: Kind, msg: Msg, dedupe: string): Promise<boolean> {
  const rows = await deps.db
    .insert(notification)
    .values({ customerId: o.customerId, orderId: o.id, kind, dedupeKey: dedupe, title: msg.title, body: msg.body })
    .onConflictDoNothing({ target: notification.dedupeKey })
    .returning({ id: notification.id });
  return rows.length > 0;
}

export async function onStatusChanged(deps: AppDeps, orderId: string, to: string) {
  const r = await loadOrder(deps, orderId);
  if (!r) return;
  const { o } = r;
  if (to === 'paid_hold') await enqueueNotification(deps, o, 'accepted', render.accepted(o), `${o.id}:accepted`);
  else if (to === 'on_the_way') {
    const c = await deps.db.transaction((tx) => courierForOrder(tx, o.id));
    await enqueueNotification(deps, o, 'courier_left', render.courierLeft(o, c?.name.split(' ').pop() ?? null, orderUrl(deps, o.id)), `${o.id}:courier_left`);
  } else if (to === 'delivered') await enqueueNotification(deps, o, 'delivered', render.delivered(o, orderUrl(deps, o.id)), `${o.id}:delivered`);
  else if (to === 'cancelled') await enqueueNotification(deps, o, 'cancelled', render.cancelled(o), `${o.id}:cancelled`);
}

/** Замена или «товара нет»: ключ — позиция + её итоговое состояние, чтобы два события одной замены дали одно сообщение. */
export async function onItemChanged(deps: AppDeps, orderId: string, itemId: string) {
  const r = await loadOrder(deps, orderId);
  if (!r) return;
  const [it] = await deps.db.select().from(orderItem).where(eq(orderItem.id, itemId));
  if (!it || (it.status !== 'missing' && it.status !== 'replaced')) return;
  const meta = (it.missingMeta ?? {}) as Record<string, unknown>;
  // звонок клиенту ещё идёт — ждём его решения, клиент и так на телефоне
  if (it.status === 'missing' && meta['call_required'] && !meta['call_resolved']) return;
  const repl = it.replacedByItemId ? (await deps.db.select().from(orderItem).where(eq(orderItem.id, it.replacedByItemId)))[0] : undefined;
  const msg = render.itemChanged(r.o, { name: it.nameSnapshot, status: it.status, replacement: repl?.nameSnapshot });
  await enqueueNotification(deps, r.o, 'item_changed', msg, `${orderId}:item:${itemId}:${it.status}`);
}

export async function onRefunded(deps: AppDeps, orderId: string, amount: number, reason: string | null, eventId: string) {
  const r = await loadOrder(deps, orderId);
  if (r) await enqueueNotification(deps, r.o, 'refunded', render.refunded(r.o, amount, reason), `${orderId}:refund:${eventId}`);
}

/** Задержка больше 5 минут от обещания (ТЗ §10): одно уведомление на заказ, с новым временем. */
export async function detectDelays(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const late = await deps.db
    .select()
    .from(order)
    .where(and(inArray(order.status, ['paid_hold', 'picking', 'cooking', 'ready', 'on_the_way']), lte(order.promisedAt, new Date(now.getTime() - DELAY_NOTIFY_MS))));
  let n = 0;
  for (const o of late) {
    const eta = new Date(now.getTime() + (o.status === 'on_the_way' ? 10 : 20) * 60_000);
    if (await enqueueNotification(deps, o, 'delayed', render.delayed(o, eta), `${o.id}:delayed`)) n++;
  }
  return n;
}

/** Отправить ожидающие пушем; где нужен запасной канал — назначить SMS через 30 с. */
export async function sendPending(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const rows = await deps.db
    .select({ n: notification, dc: customer.dcUserId })
    .from(notification)
    .innerJoin(customer, eq(customer.id, notification.customerId))
    .where(eq(notification.status, 'pending'))
    .orderBy(notification.createdAt)
    .limit(100);
  for (const { n, dc } of rows) {
    const res = await deps.channel.push(dc, { title: n.title, body: n.body, orderId: n.orderId });
    const fallback = SMS_FALLBACK.has(n.kind as Kind);
    await deps.db
      .update(notification)
      .set(
        res.ok
          ? { status: 'sent', sentAt: now, pushDeliveredAt: res.delivered ? now : null, smsDueAt: fallback && !res.delivered ? new Date(now.getTime() + SMS_AFTER_MS) : null, error: null }
          : { status: fallback ? 'sent' : 'pending', error: res.error, smsDueAt: fallback ? new Date(now.getTime() + SMS_AFTER_MS) : null },
      )
      .where(eq(notification.id, n.id));
  }
  return rows.length;
}

/** Подтверждение доставки пуша от DC Next (когда появится вебхук) — отменяет SMS. */
export async function markPushDelivered(deps: AppDeps, notificationId: string) {
  await deps.db.update(notification).set({ pushDeliveredAt: deps.clock.now() }).where(eq(notification.id, notificationId));
}

export async function smsFallback(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const rows = await deps.db
    .select({ n: notification, dc: customer.dcUserId })
    .from(notification)
    .innerJoin(customer, eq(customer.id, notification.customerId))
    .where(and(lte(notification.smsDueAt, now), isNull(notification.pushDeliveredAt), isNull(notification.smsSentAt)))
    .limit(100);
  for (const { n, dc } of rows) {
    const res = await deps.channel.sms(dc, `${n.title}. ${n.body}`);
    await deps.db
      .update(notification)
      .set(res.ok ? { smsSentAt: now, error: null } : { error: res.error, smsDueAt: new Date(now.getTime() + 60_000) })
      .where(eq(notification.id, n.id));
  }
  return rows.length;
}

export async function listForCustomer(deps: AppDeps, customerId: string) {
  const rows = await deps.db.select().from(notification).where(eq(notification.customerId, customerId)).orderBy(desc(notification.createdAt)).limit(50);
  const [u] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(notification).where(and(eq(notification.customerId, customerId), isNull(notification.readAt)));
  return {
    notifications: rows.map((n) => ({ id: n.id, order_id: n.orderId, kind: n.kind, title: n.title, body: n.body, created_at: n.createdAt.toISOString(), read: n.readAt !== null })),
    unread: u?.n ?? 0,
  };
}

export async function markRead(deps: AppDeps, customerId: string, ids: string[]) {
  await deps.db.update(notification).set({ readAt: deps.clock.now() }).where(and(eq(notification.customerId, customerId), inArray(notification.id, ids), isNull(notification.readAt)));
  return listForCustomer(deps, customerId);
}
