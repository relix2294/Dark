import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { payment, paymentOp } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';
import { PENDING_STALE_MS, paymentMachine } from './state-machine.js';

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
