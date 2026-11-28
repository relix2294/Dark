import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { courier, courierPayout, userStaff } from '../../shared/db/schema/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { publish } from '../../shared/events/outbox.js';

/**
 * Выплаты курьерам (решение заказчика): оплата за смену по тарифу точки и доплаты управляющего —
 * только безналично, на кошелёк DC. Курьер наличных не берёт.
 */

export type PayRates = { perDelivery: number; perKm: number; perHour: number };
export type ShiftStats = { delivered: number; returned: number; km: number; minutes: number };

/** Начисление за смену в дирамах. «Клиент не вышел» — поездка сделана, оплачивается как доставка. */
export function shiftPay(s: ShiftStats, r: PayRates) {
  const deliveries = (s.delivered + s.returned) * r.perDelivery;
  const km = Math.round(s.km * r.perKm);
  const hours = Math.round((s.minutes / 60) * r.perHour);
  return {
    per_delivery_dirams: r.perDelivery,
    per_km_dirams: r.perKm,
    per_hour_dirams: r.perHour,
    deliveries_dirams: deliveries,
    km_dirams: km,
    hours_dirams: hours,
    total_dirams: deliveries + km + hours,
  };
}

/** Выплата за закрытую смену: одна на смену (уникальный shift_id), нулевая не создаётся. */
export async function createShiftPayout(deps: AppDeps, p: { courierId: string; storeId: string; shiftId: string; pay: ReturnType<typeof shiftPay>; stats: ShiftStats }) {
  if (p.pay.total_dirams <= 0) return null;
  const [row] = await deps.db
    .insert(courierPayout)
    .values({
      courierId: p.courierId,
      storeId: p.storeId,
      shiftId: p.shiftId,
      kind: 'shift',
      amountDirams: p.pay.total_dirams,
      breakdown: { ...p.pay, delivered: p.stats.delivered, returned: p.stats.returned, km: p.stats.km, minutes: p.stats.minutes },
      createdBy: 'system',
    })
    .onConflictDoNothing({ target: courierPayout.shiftId })
    .returning();
  return row ?? null;
}

/** Доплата курьеру от управляющего или финансиста: отдельная выплата на DC с причиной. */
export async function createBonus(deps: AppDeps, me: StaffPrincipal, courierId: string, amount: number, reason: string) {
  const [c] = await deps.db.select({ id: courier.id, storeId: userStaff.storeId, current: courier.currentStoreId }).from(courier).innerJoin(userStaff, eq(userStaff.id, courier.staffId)).where(eq(courier.id, courierId));
  if (!c) throw notFound('Курьер', courierId);
  const storeId = c.current ?? c.storeId;
  if (!storeId) throw new AppError('VALIDATION', 'Курьер не привязан к точке');
  if (me.store_id && me.store_id !== storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
  const [row] = await deps.db.insert(courierPayout).values({ courierId, storeId, kind: 'bonus', amountDirams: amount, reason, createdBy: me.staff_id }).returning();
  return row!;
}

/** Повторы при сбое связи с банком: 1, 5, 15, 60 минут, дальше — failed и тревога финансисту. */
const RETRY_MIN = [1, 5, 15, 60];

/** Воркер раз в минуту: отправка ожидающих выплат на DC. Ключ идемпотентности — id выплаты. */
export async function sendPendingPayouts(deps: AppDeps) {
  const now = deps.clock.now();
  const due = await deps.db
    .select({ p: courierPayout, dc: userStaff.dcUserId, name: userStaff.name })
    .from(courierPayout)
    .innerJoin(courier, eq(courier.id, courierPayout.courierId))
    .innerJoin(userStaff, eq(userStaff.id, courier.staffId))
    .where(and(eq(courierPayout.status, 'pending'), or(isNull(courierPayout.nextAttemptAt), lte(courierPayout.nextAttemptAt, now))))
    .orderBy(asc(courierPayout.createdAt))
    .limit(50);
  let sent = 0;
  for (const { p, dc, name } of due) {
    const fail = async (status: 'failed' | 'no_wallet', message: string, attempts = p.attempts) =>
      deps.db.transaction(async (tx) => {
        await tx.update(courierPayout).set({ status, lastError: message, attempts, nextAttemptAt: null }).where(eq(courierPayout.id, p.id));
        await publish(tx, { topic: 'payout.failed', aggregateType: 'courier_payout', aggregateId: p.id, payload: { store_id: p.storeId, courier_name: name, amount_dirams: p.amountDirams, reason: message } });
      });
    if (!dc) {
      await fail('no_wallet', 'у курьера не указан кошелёк DC');
      continue;
    }
    const res = await deps.wallet.payout({ dcUserId: dc, amount: p.amountDirams, reference: `payout:${p.id}`, idempotencyKey: p.id });
    if (res.ok) {
      await deps.db.transaction(async (tx) => {
        await tx.update(courierPayout).set({ status: 'sent', providerRef: res.providerRef, sentAt: now, attempts: p.attempts + 1, lastError: null }).where(eq(courierPayout.id, p.id));
        await publish(tx, { topic: 'payout.sent', aggregateType: 'courier_payout', aggregateId: p.id, payload: { store_id: p.storeId, amount_dirams: p.amountDirams } });
      });
      sent++;
    } else if (res.reason === 'rejected') {
      await fail('failed', res.message, p.attempts + 1);
    } else {
      const attempts = p.attempts + 1;
      const delay = RETRY_MIN[attempts - 1];
      if (delay === undefined) await fail('failed', `нет ответа банка после ${attempts} попыток: ${res.message}`, attempts);
      else await deps.db.update(courierPayout).set({ attempts, lastError: res.message, nextAttemptAt: new Date(now.getTime() + delay * 60_000) }).where(eq(courierPayout.id, p.id));
    }
  }
  return sent;
}

/** Повторить неудавшуюся выплату (указали кошелёк, банк разблокировал) — тот же ключ: дважды не заплатим. */
export async function retryPayout(deps: AppDeps, me: StaffPrincipal, id: string) {
  const [p] = await deps.db.select().from(courierPayout).where(eq(courierPayout.id, id));
  if (!p) throw notFound('Выплата', id);
  if (me.store_id && me.store_id !== p.storeId) throw new AppError('FORBIDDEN', 'Чужая точка');
  if (!['failed', 'no_wallet'].includes(p.status)) throw new AppError('INVALID_TRANSITION', `Выплата в статусе ${p.status}`);
  const [row] = await deps.db.update(courierPayout).set({ status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null }).where(eq(courierPayout.id, id)).returning();
  return row!;
}

export const payoutView = (p: typeof courierPayout.$inferSelect) => ({
  id: p.id,
  kind: p.kind,
  amount_dirams: p.amountDirams,
  status: p.status,
  reason: p.reason,
  created_at: p.createdAt.toISOString(),
  sent_at: p.sentAt?.toISOString() ?? null,
});

/** Выплаты точки за период (дни по поясу точки) с итогами: отправлено, в очереди, проблемные. */
export async function listPayouts(deps: AppDeps, storeId: string, from: string, to: string) {
  const tz = deps.config.DISPLAY_TZ;
  const rows = await deps.db
    .select({ p: courierPayout, name: userStaff.name })
    .from(courierPayout)
    .innerJoin(courier, eq(courier.id, courierPayout.courierId))
    .innerJoin(userStaff, eq(userStaff.id, courier.staffId))
    .where(and(eq(courierPayout.storeId, storeId), sql`(${courierPayout.createdAt} at time zone ${tz})::date between ${from}::date and ${to}::date`))
    .orderBy(desc(courierPayout.createdAt));
  const sum = (st: string[]) => rows.filter((r) => st.includes(r.p.status)).reduce((a, r) => a + r.p.amountDirams, 0);
  return {
    payouts: rows.map(({ p, name }) => ({
      ...payoutView(p),
      courier_id: p.courierId,
      courier_name: name,
      breakdown: p.breakdown ?? null,
      attempts: p.attempts,
      last_error: p.lastError,
    })),
    totals: { sent_dirams: sum(['sent']), pending_dirams: sum(['pending']), problem_dirams: sum(['failed', 'no_wallet']) },
  };
}

/** Последние выплаты курьера — для его приложения. */
export async function courierPayouts(deps: AppDeps, courierId: string) {
  const rows = await deps.db.select().from(courierPayout).where(eq(courierPayout.courierId, courierId)).orderBy(desc(courierPayout.createdAt)).limit(30);
  return { payouts: rows.map(payoutView) };
}

/** Статусы выплат по сменам — для итогов смены. */
export async function payoutStatusByShift(deps: AppDeps, shiftIds: string[]) {
  if (!shiftIds.length) return new Map<string, string>();
  const rows = await deps.db.select({ s: courierPayout.shiftId, st: courierPayout.status }).from(courierPayout).where(inArray(courierPayout.shiftId, shiftIds));
  return new Map(rows.map((r) => [r.s!, r.st]));
}
