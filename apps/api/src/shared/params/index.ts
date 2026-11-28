/**
 * Настраиваемые параметры (ТЗ §12). Значения по умолчанию — здесь; переопределение по точке — таблица parameter.
 * Все длительности — в миллисекундах, проценты — числом, деньги — в дирамах.
 */
export const DEFAULT_PARAMS = {
  LAB_PICK_SLA_MS: 2 * 60_000,
  LAB_PROMISE_MS: 15 * 60_000,
  SOR_PROMISE_MS: 45 * 60_000,
  SOR_MAX_PROMISE_MS: 60 * 60_000,
  SOR_PREASSIGN_MS: 3 * 60_000,
  SOR_SLACK_BUFFER_MS: 10 * 60_000,
  LAB_RESERVE: 1,
  /** Сколько заказов курьер развозит в час — для графика курьеров. */
  COURIER_ORDERS_PER_HOUR: 3,
  RETURN_LOOKAHEAD_MS: 2 * 60_000,
  OFFER_TIMEOUT_MS: 30_000,
  AUTO_ACCEPT: true,
  NO_COURIER_WARN_MS: 3 * 60_000,
  NO_COURIER_ALERT_MS: 7 * 60_000,
  BATCH_MAX: 2,
  BATCH_DETOUR_MS: 4 * 60_000,
  HOLD_BUFFER_PCT: 10,
  REFUND_LIMIT_DIRAMS: 200 * 100,
  SOR_CANCEL_FEE_PCT: 100,
  NO_SHOW_WAIT_MS: 5 * 60_000,
  DELIVERY_GEOFENCE_M: 150,
  MIN_SHELF_LIFE_PCT: 20,
  /** Порог «мало на складе» (ТЗ §10 stock.low): штучный товар — штук, весовой — граммов. */
  LOW_STOCK_UNITS: 5,
  LOW_STOCK_GRAMS: 2000,
  STOCKTAKE_TOLERANCE_PCT: 2,
  STATION_CAPACITY: { pizza: 4, grill: 6, cold: 8, pack: 10 } as Record<string, number>,
  LAST_ORDER_BEFORE_CLOSE_MS: { LAB: 20 * 60_000, SOR: 50 * 60_000 } as Record<string, number>,
  /**
   * Тариф курьера (решение заказчика: оплата за смену, только безналично, через DC). Стартовые оценки —
   * уточняются по точке в админке, как и прочие параметры.
   */
  COURIER_PAY_PER_DELIVERY_DIRAMS: 500,
  COURIER_PAY_PER_KM_DIRAMS: 100,
  COURIER_PAY_PER_HOUR_DIRAMS: 0,
  /** Таймаут ответа банка на hold (ТЗ §5). */
  PAYMENT_HOLD_TIMEOUT_MS: 10_000,
} as const;

export type Params = { -readonly [K in keyof typeof DEFAULT_PARAMS]: (typeof DEFAULT_PARAMS)[K] };
export type ParamKey = keyof Params;

export function resolveParams(overrides: Partial<Record<ParamKey, unknown>>): Params {
  const out = { ...DEFAULT_PARAMS } as Params;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULT_PARAMS) || v === undefined || v === null) continue;
    const def = DEFAULT_PARAMS[k as ParamKey];
    if (typeof v !== typeof def) continue;
    // объектные параметры (STATION_CAPACITY, LAST_ORDER_BEFORE_CLOSE_MS) — слияние по ключам, только числа
    if (typeof def === 'object') {
      const merged: Record<string, number> = { ...(def as Record<string, number>) };
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) if (typeof vv === 'number') merged[kk] = vv;
      (out as Record<string, unknown>)[k] = merged;
    } else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
