/** Деньги приходят целыми дирамами; показываем в сомони. */
export const somoni = (d: number | null | undefined): string => (d == null ? '—' : `${Math.floor(d / 100)}.${String(d % 100).padStart(2, '0')} с`);

const tz = 'Asia/Dushanbe';
export const time = (iso: string | null | undefined): string => (iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
export const dateTime = (iso: string | null | undefined): string =>
  iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

/** Минуты до/после момента: «+3 мин» (опоздание) или «−12 мин» (запас). */
export const minutesLeft = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return '—';
  const m = Math.round((new Date(iso).getTime() - now) / 60_000);
  return m >= 0 ? `${m} мин` : `опоздание ${-m} мин`;
};

export const ORDER_STATUS_RU: Record<string, string> = {
  created: 'Проверяем оплату',
  paid_hold: 'Оплачен',
  payment_failed: 'Оплата не прошла',
  picking: 'Собирается',
  cooking: 'Готовится',
  ready: 'Готов',
  on_the_way: 'В пути',
  delivered: 'Доставлен',
  returning: 'Возвращается',
  returned: 'Возвращён',
  cancelled: 'Отменён',
};

export const COURIER_STATUS_RU: Record<string, string> = {
  offline: 'Не на смене',
  free: 'Свободен',
  assigned: 'Назначен',
  delivering: 'Везёт',
  returning: 'Возвращается',
  break: 'Перерыв',
};

export const BRAND_RU: Record<string, string> = { LAB: 'Lablabu', SOR: 'Sor Box' };
