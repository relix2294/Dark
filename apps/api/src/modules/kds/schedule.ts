import type { Station } from '@dark/contracts';

export type DishToCook = { orderItemId: string; station: Station; cookTimeSec: number };
export type StationLoad = Record<Station, { inProgress: number; capacity: number; queuedSec: number }>;

export type ScheduledDish = DishToCook & { startAt: Date; targetReadyAt: Date; delaySec: number };

/**
 * Старт блюда = целевая готовность заказа − cook_time блюда.
 * Целевая готовность = сейчас + самое долгое блюдо + очередь его станции.
 * Очередь станции: если в работе >= capacity — задержка = накопленные секунды очереди.
 */
export function scheduleOrder(now: Date, dishes: DishToCook[], load: StationLoad): { targetReadyAt: Date; dishes: ScheduledDish[] } {
  if (dishes.length === 0) throw new Error('пустой заказ');
  const delayFor = (s: Station) => {
    const l = load[s];
    return l.inProgress >= l.capacity ? l.queuedSec : 0;
  };
  const longest = Math.max(...dishes.map((d) => d.cookTimeSec + delayFor(d.station)));
  const targetReadyAt = new Date(now.getTime() + longest * 1000);
  const scheduled = dishes.map((d) => {
    const delaySec = delayFor(d.station);
    const startAt = new Date(targetReadyAt.getTime() - d.cookTimeSec * 1000);
    return { ...d, startAt, targetReadyAt, delaySec };
  });
  return { targetReadyAt, dishes: scheduled };
}

/** Цвет на экране кухни: серый до старта, жёлтый в работе, красный при опоздании (ТЗ §8). */
export function dishColor(now: Date, d: Pick<ScheduledDish, 'startAt' | 'targetReadyAt'>, doneAt: Date | null): 'grey' | 'yellow' | 'red' | 'done' {
  if (doneAt) return 'done';
  if (now < d.startAt) return 'grey';
  if (now > d.targetReadyAt) return 'red';
  return 'yellow';
}

/** promised_at = готовность + ожидание курьера + путь (ТЗ §8). */
export function sorPromise(targetReadyAt: Date, courierWaitMs: number, travelMs: number): Date {
  return new Date(targetReadyAt.getTime() + courierWaitMs + travelMs);
}
