import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { courier, courierPosition, courierShift, deliveryTask, order } from '../../shared/db/schema/index.js';
import { AppError } from '../../shared/errors/index.js';
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

/**
 * Итоги смены курьера (ТЗ §9 «заработок за смену»). Модель оплаты не утверждена (ТЗ §12, открытые вопросы),
 * поэтому денег здесь нет — только то, из чего оплата будет считаться: время, доставки, пробег.
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
  const from = shift.startedAt;
  const to = shift.endedAt ?? now;

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
    .where(and(eq(deliveryTask.courierId, c.id), gte(deliveryTask.assignedAt, from), lte(deliveryTask.assignedAt, to)));

  const track = await deps.db
    .select({ lat: courierPosition.lat, lon: courierPosition.lon, at: courierPosition.at, accuracyM: courierPosition.accuracyM })
    .from(courierPosition)
    .where(and(eq(courierPosition.courierId, c.id), gte(courierPosition.at, from), lte(courierPosition.at, to)))
    .orderBy(asc(courierPosition.at));

  return {
    shift_started_at: from.toISOString(),
    shift_ended_at: shift.endedAt?.toISOString() ?? null,
    minutes: Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)),
    trips: o?.tasks ?? 0,
    delivered: o?.delivered ?? 0,
    on_time: o?.onTime ?? 0,
    returned: o?.returned ?? 0,
    avg_delivery_min: o?.avgMin != null ? Math.round(o.avgMin) : null,
    km: pathKm(track),
  };
}
