import type { Transport } from '@dark/contracts';
import { travelMinutes, type Geo } from '../../shared/geo.js';

/**
 * Объединение поездок (ТЗ §6, этап 2). Чистая проверка: можно ли курьеру везти эти заказы одной поездкой
 * в данном порядке. Правила ТЗ:
 * - не больше BATCH_MAX заказов;
 * - LAB + LAB: готовы с разницей не больше 2 минут, крюк не больше BATCH_DETOUR, обещание не нарушается;
 * - LAB + SOR: LAB доставляется первым, SOR теряет не больше 5 минут; два SOR в одну поездку не объединяем.
 */
export type TripOrder = { id: string; brand: 'LAB' | 'SOR'; readyEta: Date; promisedAt: Date; address: Geo };

export const LAB_READY_GAP_MIN = 2;
export const SOR_MAX_LOSS_MIN = 5;

const MIN = 60_000;

/** Время маршрута точка → адреса по порядку → точка, минут. */
export function routeMinutes(store: Geo, seq: TripOrder[], transport: Transport): number {
  let t = 0;
  let at: Geo = store;
  for (const o of seq) {
    t += travelMinutes(at, o.address, transport);
    at = o.address;
  }
  return t + travelMinutes(at, store, transport);
}

/** Время прибытия к каждому адресу: выезд, когда готов последний заказ поездки. */
export function arrivals(store: Geo, seq: TripOrder[], transport: Transport, now: Date): number[] {
  const depart = Math.max(now.getTime(), ...seq.map((o) => o.readyEta.getTime()));
  let t = depart;
  let at: Geo = store;
  return seq.map((o) => {
    t += travelMinutes(at, o.address, transport) * MIN;
    at = o.address;
    return t;
  });
}

const aloneArrival = (store: Geo, o: TripOrder, transport: Transport, now: Date) =>
  Math.max(now.getTime(), o.readyEta.getTime()) + travelMinutes(store, o.address, transport) * MIN;

export type BatchCheck = { ok: true; seq: TripOrder[]; detourMin: number } | { ok: false; reason: string };

/** Добавить заказ к поездке: LAB встаёт перед SOR, иначе — в конец. Возвращает итоговый порядок или причину отказа. */
export function tryAddToTrip(
  store: Geo,
  trip: TripOrder[],
  add: TripOrder,
  transport: Transport,
  now: Date,
  p: { BATCH_MAX: number; BATCH_DETOUR_MS: number },
): BatchCheck {
  if (trip.length + 1 > p.BATCH_MAX) return { ok: false, reason: 'batch_max' };
  const labs = [...trip.filter((o) => o.brand === 'LAB'), ...(add.brand === 'LAB' ? [add] : [])];
  const sors = [...trip.filter((o) => o.brand === 'SOR'), ...(add.brand === 'SOR' ? [add] : [])];
  if (sors.length > 1) return { ok: false, reason: 'sor_sor' };
  const seq = [...labs, ...sors]; // LAB всегда раньше SOR

  if (labs.length > 1) {
    const r = labs.map((o) => o.readyEta.getTime());
    if ((Math.max(...r) - Math.min(...r)) / MIN > LAB_READY_GAP_MIN) return { ok: false, reason: 'lab_ready_gap' };
  }
  const detour = routeMinutes(store, seq, transport) - routeMinutes(store, trip, transport);
  if (detour * MIN > p.BATCH_DETOUR_MS) return { ok: false, reason: 'detour' };

  const arr = arrivals(store, seq, transport, now);
  for (const [i, o] of seq.entries()) {
    const alone = aloneArrival(store, o, transport, now);
    if (o.brand === 'SOR') {
      if ((arr[i]! - alone) / MIN > SOR_MAX_LOSS_MIN) return { ok: false, reason: 'sor_loss' };
    } else if (arr[i]! > Math.max(o.promisedAt.getTime(), alone)) return { ok: false, reason: 'promise' };
  }
  return { ok: true, seq, detourMin: Math.round(detour * 10) / 10 };
}
