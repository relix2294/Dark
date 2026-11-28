import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { courier, courierPosition, courierShift, deliveryTask, order } from '../../shared/db/schema/index.js';
import { AppError } from '../../shared/errors/index.js';
import { loadParams } from '../../shared/params/load.js';
import { createShiftPayout, payoutStatusByShift, shiftPay } from '../payments/index.js';
import { distanceM } from '../../shared/geo.js';

/** Точки хуже этой точности в пробег не идут — GPS у подъездов «прыгает». */
const MAX_ACCURACY_M = 50;
/** Скачок быстрее 90 км/ч для городской доставки — сбой GPS, не поездка. */
const MAX_SPEED_MPS = 25;
/** Закрытую смену показываем как «итоги» ещё 12 часов. */
const SHOW_ENDED_MS = 12 * 3600_000;

export type TrackPoint = { lat: number; lon: number; at: Date; accuracyM: number };

/** Пробег по треку, км (0,1 км точности): без неточных точек и физически невозможных скачков. */
export function pathKm(points: TrackPoint[]): number {
  let m = 0;
  let prev: TrackPoint | null = null;
  for (const p of points) {
    if (p.accuracyM > MAX_ACCURACY_M) continue;
    if (prev) {
      const d = distanceM(prev, p);
      const sec = (p.at.getTime() - prev.at.getTime()) / 1000;
      if (sec <= 0 || d / sec > MAX_SPEED_MPS) continue; // скачок: точку пропускаем, опорной остаётся прежняя
      m += d;
    }
    prev = p;
  }
  return Math.round(m / 100) / 10;
}

type Shift = typeof courierShift.$inferSelect;

/** Показатели смены: из них считается оплата (доставки, возвраты, км, минуты) и витрина итогов. */
export async function shiftStats(deps: AppDeps, courierId: string, shift: Shift) {
  const from = shift.startedAt!;
  const to = shift.endedAt ?? deps.clock.now();
  const [o] = await deps.db
    .select({
      delivered: sql<number>`count(*) filter (where ${order.status} = 'delivered')::int`,
      onTime: sql<number>`count(*) filter (where ${order.status} = 'delivered' and ${order.deliveredAt} <= ${order.promisedAt})::int`,
      returned: sql<number>`count(*) filter (where ${order.status} = 'returned')::int`,
      avgMin: sql<number | null>`avg(extract(epoch from ${order.deliveredAt} - ${deliveryTask.pickedUpAt}) / 60) filter (where ${order.status} = 'delivered')::float`,
      tasks: sql<number>`count(distinct ${deliveryTask.id})::int`,
    })
    .from(deliveryTask)
    .innerJoin(order, sql`${order.id} = any(${deliveryTask.orderIds})`)
    .where(and(eq(deliveryTask.courierId, courierId), gte(deliveryTask.assignedAt, from), lte(deliveryTask.assignedAt, to)));
  const track = await deps.db
    .select({ lat: courierPosition.lat, lon: courierPosition.lon, at: courierPosition.at, accuracyM: courierPosition.accuracyM })
    .from(courierPosition)
    .where(and(eq(courierPosition.courierId, courierId), gte(courierPosition.at, from), lte(courierPosition.at, to)))
    .orderBy(asc(courierPosition.at));
  return {
    from,
    to,
    minutes: Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)),
    trips: o?.tasks ?? 0,
    delivered: o?.delivered ?? 0,
    onTime: o?.onTime ?? 0,
    returned: o?.returned ?? 0,
    avgMin: o?.avgMin != null ? Math.round(o.avgMin) : null,
    km: pathKm(track),
  };
}

/** Начисление за смену по тарифу точки (параметры COURIER_PAY_*). */
export async function shiftPayFor(deps: AppDeps, shift: Shift, st: Awaited<ReturnType<typeof shiftStats>>) {
  const P = await loadParams(deps.db, shift.storeId);
  return shiftPay(st, { perDelivery: P.COURIER_PAY_PER_DELIVERY_DIRAMS, perKm: P.COURIER_PAY_PER_KM_DIRAMS, perHour: P.COURIER_PAY_PER_HOUR_DIRAMS });
}

/**
 * Итоги смены курьера (ТЗ §9 «заработок за смену»): время, поездки, доставки, пробег и начисление.
 * Деньги — только безналично: после закрытия смены выплата уходит на кошелёк DC курьера.
 */
export async function shiftSummary(deps: AppDeps, me: StaffPrincipal) {
  const now = deps.clock.now();
  const [c] = await deps.db.select().from(courier).where(eq(courier.staffId, me.staff_id));
  if (!c) throw new AppError('NOT_FOUND', 'Курьер не найден');
  const [shift] = await deps.db
    .select()
    .from(courierShift)
    .where(and(eq(courierShift.courierId, c.id), or(isNull(courierShift.endedAt), gte(courierShift.endedAt, new Date(now.getTime() - SHOW_ENDED_MS)))))
    .orderBy(desc(courierShift.startedAt))
    .limit(1);
  if (!shift?.startedAt) return null;
  const st = await shiftStats(deps, c.id, shift);
  const pay = await shiftPayFor(deps, shift, st);
  const payout = shift.endedAt ? (await payoutStatusByShift(deps, [shift.id])).get(shift.id) : undefined;
  return {
    shift_started_at: st.from.toISOString(),
    shift_ended_at: shift.endedAt?.toISOString() ?? null,
    minutes: st.minutes,
    trips: st.trips,
    delivered: st.delivered,
    on_time: st.onTime,
    returned: st.returned,
    avg_delivery_min: st.avgMin,
    km: st.km,
    pay,
    // смена закрыта, а выплаты нет — начислено 0
    payout_status: shift.endedAt ? ((payout as 'pending' | 'sent' | 'failed' | 'no_wallet' | undefined) ?? null) : null,
  };
}

/** Закрытие смены: выплата за смену на DC (воркер отправит). Повторный вызов не создаст вторую. */
export async function payoutForEndedShift(deps: AppDeps, courierId: string) {
  const [shift] = await deps.db
    .select()
    .from(courierShift)
    .where(and(eq(courierShift.courierId, courierId), sql`${courierShift.endedAt} is not null`))
    .orderBy(desc(courierShift.endedAt))
    .limit(1);
  if (!shift?.startedAt) return null;
  const st = await shiftStats(deps, courierId, shift);
  const pay = await shiftPayFor(deps, shift, st);
  return createShiftPayout(deps, { courierId, storeId: shift.storeId, shiftId: shift.id, pay, stats: { delivered: st.delivered, returned: st.returned, km: st.km, minutes: st.minutes } });
}
