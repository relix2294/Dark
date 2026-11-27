/** Время храним в UTC, показываем в Asia/Dushanbe (ТЗ §1). Все вычисления — на Date/epoch ms. */
export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

export const SEC = 1000;
export const MIN = 60 * SEC;

export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
export const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / MIN;

export function formatLocal(d: Date, tz = 'Asia/Dushanbe'): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
