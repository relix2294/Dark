import type { Brand, Transport } from '@dark/contracts';
import { travelMinutes, type Geo } from '../../shared/geo.js';
import type { Params } from '../../shared/params/index.js';

/**
 * Диспетчер курьеров (ТЗ §6): чистая функция без БД. Вход — снимок состояния точки, выход —
 * назначения с указанием правила и снимок для разбора. Сервис применяет результат в транзакции.
 */
export type PendingOrder = {
  id: string;
  brand: Brand;
  createdAt: Date;
  /** Прогноз готовности: LAB — старт сборки + LAB_PICK_SLA; SOR — максимум по блюдам + очередь станции. */
  readyEta: Date;
  promisedAt: Date;
  address: Geo;
  /** Заказ уже готов (статус ready) — для контроля ожидания. */
  readyAt: Date | null;
};

export type FreeCourier = {
  id: string;
  transport: Transport;
  position: Geo;
  /** returning: через сколько минут вернётся на точку; free — 0. */
  etaToStoreMin: number;
};

export type DispatchInput = {
  now: Date;
  store: Geo;
  orders: PendingOrder[];
  couriers: FreeCourier[];
  /** Были ли активные корзины LAB за последние 5 минут (резерв под LAB нужен). */
  labDemandRecent: boolean;
  params: Pick<Params, 'SOR_PREASSIGN_MS' | 'SOR_SLACK_BUFFER_MS' | 'LAB_RESERVE' | 'RETURN_LOOKAHEAD_MS' | 'NO_COURIER_WARN_MS' | 'NO_COURIER_ALERT_MS'>;
};

export type Rule = 'sor_urgent' | 'lab_fifo' | 'sor_regular';

export type Assignment = { orderId: string; courierId: string; rule: Rule; slackMin: number; travelMin: number };
export type Alert = { orderId: string; level: 'warn' | 'alert'; waitingMin: number };

export type DispatchResult = {
  assignments: Assignment[];
  deferred: { orderId: string; reason: 'lab_reserve' | 'no_courier' | 'not_due' }[];
  alerts: Alert[];
  /** Снимок входа: что видел диспетчер — обязателен для разбора (ТЗ §6). */
  snapshot: Record<string, unknown>;
};

const MIN = 60_000;

export function slackMinutes(o: PendingOrder, now: Date, courier: FreeCourier, store: Geo): number {
  const travel = travelMinutes(store, o.address, courier.transport);
  return (o.promisedAt.getTime() - now.getTime()) / MIN - travel;
}

export function planDispatch(input: DispatchInput): DispatchResult {
  const { now, store, params } = input;
  const free = input.couriers
    .filter((c) => c.etaToStoreMin * MIN <= params.RETURN_LOOKAHEAD_MS)
    .map((c) => ({ ...c }));
  const assignments: Assignment[] = [];
  const deferred: DispatchResult['deferred'] = [];
  const alerts: Alert[] = [];

  const refTransport: Transport = free[0]?.transport ?? 'bike';
  const slackOf = (o: PendingOrder) =>
    (o.promisedAt.getTime() - now.getTime()) / MIN - travelMinutes(store, o.address, refTransport);

  const lab = input.orders.filter((o) => o.brand === 'LAB').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sorAll = input.orders.filter((o) => o.brand === 'SOR');
  const sor = sorAll
    .filter((o) => o.readyEta.getTime() - now.getTime() <= params.SOR_PREASSIGN_MS)
    .sort((a, b) => slackOf(a) - slackOf(b));
  for (const o of sorAll) if (!sor.includes(o)) deferred.push({ orderId: o.id, reason: 'not_due' });

  const snapshot = {
    at: now.toISOString(),
    free: free.map((c) => ({ id: c.id, transport: c.transport, etaToStoreMin: c.etaToStoreMin })),
    lab: lab.map((o) => o.id),
    sor: sor.map((o) => ({ id: o.id, slackMin: Math.round(slackOf(o) * 10) / 10 })),
    labDemandRecent: input.labDemandRecent,
  };

  const nearest = (o: PendingOrder): FreeCourier | undefined => {
    let best: FreeCourier | undefined;
    let bestT = Infinity;
    for (const c of free) {
      const t = c.etaToStoreMin + travelMinutes(store, o.address, c.transport);
      if (t < bestT) {
        best = c;
        bestT = t;
      }
    }
    return best;
  };

  const assign = (o: PendingOrder, rule: Rule): boolean => {
    const c = nearest(o);
    if (!c) {
      deferred.push({ orderId: o.id, reason: 'no_courier' });
      return false;
    }
    free.splice(free.indexOf(c), 1);
    assignments.push({
      orderId: o.id,
      courierId: c.id,
      rule,
      slackMin: Math.round(slackMinutes(o, now, c, store) * 10) / 10,
      travelMin: Math.round(travelMinutes(store, o.address, c.transport) * 10) / 10,
    });
    return true;
  };

  // 1. Срочные SOR: запас исчерпан — выше любого нового LAB
  const sorRest: PendingOrder[] = [];
  for (const o of sor) {
    if (slackOf(o) * MIN <= params.SOR_SLACK_BUFFER_MS) assign(o, 'sor_urgent');
    else sorRest.push(o);
  }

  // 2. LAB в порядке очереди
  for (const o of lab) assign(o, 'lab_fifo');

  // 3. Остальные SOR — только если остаётся резерв под LAB
  for (const o of sorRest) {
    if (free.length > params.LAB_RESERVE || !input.labDemandRecent) assign(o, 'sor_regular');
    else deferred.push({ orderId: o.id, reason: 'lab_reserve' });
  }

  // 4. Контроль ожидания готовых заказов без курьера
  const assignedIds = new Set(assignments.map((a) => a.orderId));
  for (const o of input.orders) {
    if (!o.readyAt || assignedIds.has(o.id)) continue;
    const wait = now.getTime() - o.readyAt.getTime();
    if (wait > params.NO_COURIER_ALERT_MS) alerts.push({ orderId: o.id, level: 'alert', waitingMin: Math.round(wait / MIN) });
    else if (wait > params.NO_COURIER_WARN_MS) alerts.push({ orderId: o.id, level: 'warn', waitingMin: Math.round(wait / MIN) });
  }

  return { assignments, deferred, alerts, snapshot };
}
