import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { payment, paymentOp } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { PENDING_STALE_MS, paymentMachine } from './state-machine.js';
import type { HoldResult } from './adapter.js';

/**
 * Платежи (ТЗ §5): холд ставит orders при создании заказа; здесь — capture при доставке, release при отмене,
 * refund, сверка зависших и повторы. Все переходы — через paymentMachine, ключ операции {order}:{type}:{seq}.
 */

/** Повторы неуспешного capture: 1, 5, 15 мин, затем раз в час в течение суток, потом тревога (ТЗ §5 п.7). */
export const CAPTURE_RETRY_DELAYS_SEC = [60, 300, 900, ...Array.from({ length: 24 }, () => 3600)];

async function nextOp(tx: Tx, paymentId: string, orderId: string, type: 'capture' | 'release' | 'refund', amount: number) {
  const [cnt] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentOp)
    .where(and(eq(paymentOp.paymentId, paymentId), eq(paymentOp.type, type)));
  const key = `${orderId}:${type}:${(cnt?.n ?? 0) + 1}`;
  await tx.insert(paymentOp).values({ paymentId, type, amountDirams: amount, idempotencyKey: key });
  return key;
}

async function setStatus(tx: Tx, p: typeof payment.$inferSelect, to: typeof p.status, patch: Partial<typeof payment.$inferInsert> = {}) {
  paymentMachine.assert(p.status, to, 'system');
  await tx.update(payment).set({ status: to, ...patch }).where(and(eq(payment.id, p.id), eq(payment.status, p.status)));
}

/** Создание заказа: payment(hold_pending) + payment_op(hold) в транзакции заказа (ТЗ §5 п.1). */
export async function openHold(tx: Tx, orderId: string, amount: number) {
  const [p] = await tx.insert(payment).values({ orderId, status: 'hold_pending', holdDirams: amount }).returning();
  const key = `${orderId}:hold:1`;
  await tx.insert(paymentOp).values({ paymentId: p!.id, type: 'hold', amountDirams: amount, idempotencyKey: key });
  return { paymentId: p!.id, key };
}

/** Результат hold от банка (ТЗ §5 п.3–4). timeout — платёж остаётся hold_pending, решит сверка. */
export async function applyHoldResult(tx: Tx, paymentId: string, key: string, res: HoldResult) {
  const [p] = await tx.select().from(payment).where(eq(payment.id, paymentId)).for('update');
  if (!p) throw notFound('Платёж', paymentId);
  if (res.ok) {
    await setStatus(tx, p, 'held', { providerRef: res.providerRef, holdExpiresAt: res.expiresAt, lastError: null });
    await tx.update(paymentOp).set({ status: 'ok' }).where(eq(paymentOp.idempotencyKey, key));
    await publish(tx, { topic: 'payment.held', aggregateType: 'payment', aggregateId: p.id, payload: { order_id: p.orderId, amount: p.holdDirams } });
  } else if (res.reason === 'timeout') {
    await tx.update(payment).set({ lastError: res.message }).where(eq(payment.id, p.id));
  } else {
    await setStatus(tx, p, 'failed', { lastError: res.message });
    await tx.update(paymentOp).set({ status: 'failed' }).where(eq(paymentOp.idempotencyKey, key));
    await publish(tx, { topic: 'payment.failed', aggregateType: 'payment', aggregateId: p.id, payload: { order_id: p.orderId, reason: res.reason } });
  }
}

/** Доставлено: списание фактической суммы. Готовит capture_pending в транзакции заказа; банк вызывается отдельно (executeCapture). */
export async function prepareCapture(tx: Tx, orderId: string, amount: number) {
  const [p] = await tx.select().from(payment).where(eq(payment.orderId, orderId)).for('update');
  if (!p) throw notFound('Платёж по заказу', orderId);
  if (amount > p.holdDirams) throw new AppError('PAYMENT_DECLINED', 'Сумма списания больше холда', { hold: p.holdDirams, amount });
  await setStatus(tx, p, 'capture_pending');
  const key = await nextOp(tx, p.id, orderId, 'capture', amount);
  return { paymentId: p.id, key, amount };
}

/** Вызов банка и фиксация результата. Возвращает ok=false, если нужен повтор. */
export async function executeCapture(deps: AppDeps, paymentId: string): Promise<{ ok: boolean; done?: boolean }> {
  const [p] = await deps.db.select().from(payment).where(eq(payment.id, paymentId));
  if (!p) return { ok: true, done: true };
  if (p.status === 'captured') return { ok: true, done: true };
  if (p.status !== 'capture_pending' || !p.providerRef) return { ok: true, done: true };
  const [op] = await deps.db
    .select()
    .from(paymentOp)
    .where(and(eq(paymentOp.paymentId, p.id), eq(paymentOp.type, 'capture'), eq(paymentOp.status, 'pending')))
    .orderBy(sql`${paymentOp.createdAt} desc`)
    .limit(1);
  if (!op) return { ok: true, done: true };
  const res = await deps.wallet.capture({ providerRef: p.providerRef, amount: op.amountDirams, idempotencyKey: op.idempotencyKey });
  await deps.db.transaction(async (tx) => {
    if (res.ok) {
      await tx.update(paymentOp).set({ status: 'ok' }).where(eq(paymentOp.id, op.id));
      await setStatus(tx, p, 'captured', { capturedDirams: op.amountDirams, lastError: null });
      await publish(tx, { topic: 'payment.captured', aggregateType: 'payment', aggregateId: p.id, payload: { order_id: p.orderId, amount: op.amountDirams } });
    } else {
      // операция остаётся pending под тем же ключом: повтор с тем же ключом не создаст второго списания (ТЗ §5)
      await tx.update(paymentOp).set({ providerResponse: { reason: res.reason, message: res.message, at: deps.clock.now().toISOString() } }).where(eq(paymentOp.id, op.id));
      await tx.update(payment).set({ lastError: res.message }).where(eq(payment.id, p.id));
    }
  });
  return { ok: res.ok };
}

/** Снятие холда при отмене до списания. */
export async function releaseHold(tx: Tx, deps: AppDeps, orderId: string) {
  const [p] = await tx.select().from(payment).where(eq(payment.orderId, orderId)).for('update');
  if (!p) return;
  if (p.status !== 'held' || !p.providerRef) return;
  const key = await nextOp(tx, p.id, orderId, 'release', p.holdDirams);
  const r = await deps.wallet.release({ providerRef: p.providerRef, idempotencyKey: key });
  await tx.update(paymentOp).set({ status: r.ok ? 'ok' : 'failed' }).where(eq(paymentOp.idempotencyKey, key));
  if (r.ok) await setStatus(tx, p, 'released');
  else await tx.update(payment).set({ lastError: r.message }).where(eq(payment.id, p.id));
}

/** Частичное списание при отмене после готовки / неявке: capture на сумму fee, остаток холда снимается банком. */
export async function captureAmountNow(deps: AppDeps, orderId: string, amount: number) {
  if (amount <= 0) {
    await deps.db.transaction((tx) => releaseHold(tx, deps, orderId));
    return;
  }
  const prepared = await deps.db.transaction((tx) => prepareCapture(tx, orderId, amount));
  return executeCapture(deps, prepared.paymentId);
}

/** Возврат после списания: сумма сверх REFUND_LIMIT требует роли управляющего/финансиста (проверяет вызывающий). */
export async function refund(deps: AppDeps, orderId: string, amount: number, actorId: string, reason: string) {
  return deps.db.transaction(async (tx) => {
    const [p] = await tx.select().from(payment).where(eq(payment.orderId, orderId)).for('update');
    if (!p) throw notFound('Платёж по заказу', orderId);
    if (!['captured', 'partially_refunded'].includes(p.status) || !p.providerRef) throw new AppError('INVALID_TRANSITION', 'Возврат возможен только после списания', { status: p.status });
    if (p.refundedDirams + amount > p.capturedDirams) throw new AppError('VALIDATION', 'Возврат больше списанного', { captured: p.capturedDirams, refunded: p.refundedDirams });
    const key = await nextOp(tx, p.id, orderId, 'refund', amount);
    await setStatus(tx, p, 'refund_pending');
    const r = await deps.wallet.refund({ providerRef: p.providerRef, amount, idempotencyKey: key });
    const [cur] = await tx.select().from(payment).where(eq(payment.id, p.id));
    if (!r.ok) {
      await tx.update(paymentOp).set({ status: 'failed' }).where(eq(paymentOp.idempotencyKey, key));
      await tx.update(payment).set({ status: p.status, lastError: r.message }).where(eq(payment.id, p.id));
      throw new AppError('PAYMENT_DECLINED', `Банк отклонил возврат: ${r.message}`);
    }
    const refunded = p.refundedDirams + amount;
    const to = refunded === p.capturedDirams ? 'refunded' : 'partially_refunded';
    await tx.update(paymentOp).set({ status: 'ok', providerResponse: { reason, by: actorId } }).where(eq(paymentOp.idempotencyKey, key));
    await setStatus(tx, cur!, to, { refundedDirams: refunded });
    await publish(tx, { topic: 'payment.refunded', aggregateType: 'payment', aggregateId: p.id, payload: { order_id: orderId, amount, reason, by: actorId } });
    return { payment_status: to, refunded_dirams: refunded, captured_dirams: p.capturedDirams };
  });
}

/**
 * Сверка зависших (ТЗ §3, §5 п.4): *_pending старше 60 с.
 * hold_pending без provider_ref → отказ (нет ответа банка); capture_pending → status() у банка.
 * Возвращает id заказов, которым нужен payment_failed (их переводит orders).
 */
export async function reconcilePending(deps: AppDeps): Promise<{ failedOrderIds: string[]; retryCaptureIds: string[] }> {
  const stale = new Date(deps.clock.now().getTime() - PENDING_STALE_MS);
  const rows = await deps.db
    .select()
    .from(payment)
    .where(and(inArray(payment.status, ['hold_pending', 'capture_pending', 'refund_pending']), lt(payment.updatedAt, stale)));
  const failedOrderIds: string[] = [];
  const retryCaptureIds: string[] = [];
  for (const p of rows) {
    if (p.status === 'hold_pending') {
      const st = p.providerRef ? await deps.wallet.status(p.providerRef) : 'unknown';
      if (st === 'held') {
        await deps.db.transaction((tx) => setStatus(tx, p, 'held'));
      } else {
        await deps.db.transaction(async (tx) => {
          await setStatus(tx, p, 'failed', { lastError: 'нет ответа банка за 60 с' });
          await tx.update(paymentOp).set({ status: 'failed' }).where(and(eq(paymentOp.paymentId, p.id), eq(paymentOp.status, 'pending')));
          await publish(tx, { topic: 'payment.failed', aggregateType: 'payment', aggregateId: p.id, payload: { order_id: p.orderId, reason: 'timeout' } });
        });
        failedOrderIds.push(p.orderId);
      }
    } else if (p.status === 'capture_pending') {
      const st = p.providerRef ? await deps.wallet.status(p.providerRef) : 'unknown';
      if (st === 'captured') {
        const [op] = await deps.db.select().from(paymentOp).where(and(eq(paymentOp.paymentId, p.id), eq(paymentOp.type, 'capture'))).orderBy(sql`${paymentOp.createdAt} desc`).limit(1);
        await deps.db.transaction((tx) => setStatus(tx, p, 'captured', { capturedDirams: op?.amountDirams ?? p.holdDirams }));
      } else retryCaptureIds.push(p.id);
    }
  }
  return { failedOrderIds, retryCaptureIds };
}

/**
 * Страховка от зависших денег: холд остался у заказа, который уже отменён или не оплачен
 * (release не прошёл из-за сбоя банка). Снимаем холд; при неуспехе попробуем на следующем проходе.
 */
export async function releaseOrphanHolds(deps: AppDeps): Promise<string[]> {
  const rows = await deps.db.execute<{ order_id: string }>(sql`
    select p.order_id from payment p join "order" o on o.id = p.order_id
    where p.status = 'held' and o.status in ('cancelled', 'payment_failed') and coalesce(o.captured_dirams, 0) = 0`);
  const released: string[] = [];
  for (const r of rows.rows) {
    await deps.db.transaction((tx) => releaseHold(tx, deps, r.order_id));
    const [p] = await deps.db.select({ s: payment.status }).from(payment).where(eq(payment.orderId, r.order_id));
    if (p?.s === 'released') released.push(r.order_id);
  }
  return released;
}

/** За 10 минут до истечения холда у незавершённого заказа — тревога оператору (ТЗ §5). Не чаще раза в 10 минут. */
export async function warnExpiringHolds(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  const rows = await deps.db.execute<{ id: string; order_id: string; store_id: string; expires: Date }>(sql`
    select p.id, p.order_id, o.store_id, p.hold_expires_at expires from payment p join "order" o on o.id = p.order_id
    where p.status = 'held' and p.hold_expires_at < ${new Date(now.getTime() + 10 * 60_000)}
      and o.status in ('paid_hold', 'picking', 'cooking', 'ready', 'on_the_way', 'returning')
      and not exists (select 1 from outbox e where e.topic = 'payment.hold_expiring' and e.aggregate_id = p.id::text
                      and e.created_at > ${new Date(now.getTime() - 10 * 60_000)})`);
  for (const r of rows.rows) {
    await deps.db.transaction((tx) =>
      publish(tx, { topic: 'payment.hold_expiring', aggregateType: 'payment', aggregateId: r.id, payload: { order_id: r.order_id, store_id: r.store_id, expires_at: new Date(r.expires).toISOString() } }),
    );
  }
  return rows.rows.length;
}

/**
 * Ночная сверка (ТЗ §5, 04:00): каждое успешное списание и возврат за сутки сверяется с состоянием у банка.
 * Пока реестр банка не получен — через status(); после — сравнение с реестром за тем же интерфейсом.
 */
export async function nightlyReconcile(deps: AppDeps, day: Date): Promise<{ checked: number; mismatches: { payment_id: string; expected: string; bank: string }[] }> {
  const from = new Date(day.getTime() - 24 * 3600_000);
  const rows = await deps.db.execute<{ payment_id: string; provider_ref: string; status: string }>(sql`
    select distinct p.id payment_id, p.provider_ref, p.status from payment_op op join payment p on p.id = op.payment_id
    where op.status = 'ok' and op.type in ('capture', 'refund') and op.updated_at >= ${from} and op.updated_at < ${day}
      and p.provider_ref is not null`);
  const expected: Record<string, string[]> = { captured: ['captured'], partially_refunded: ['refunded', 'captured'], refunded: ['refunded'] };
  const mismatches: { payment_id: string; expected: string; bank: string }[] = [];
  for (const r of rows.rows) {
    const bank = await deps.wallet.status(r.provider_ref);
    if (!(expected[r.status] ?? [r.status]).includes(bank)) mismatches.push({ payment_id: r.payment_id, expected: r.status, bank });
  }
  if (mismatches.length) {
    await deps.db.transaction(async (tx) => {
      for (const m of mismatches) await publish(tx, { topic: 'payment.reconcile_mismatch', aggregateType: 'payment', aggregateId: m.payment_id, payload: m });
    });
  }
  return { checked: rows.rows.length, mismatches };
}
