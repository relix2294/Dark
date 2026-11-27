import type { WorkHours } from '../../shared/db/schema/refs.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Открыта ли точка в момент now по локальному времени tz. Поддерживает интервалы через полночь. */
export function isOpenAt(hours: WorkHours, now: Date, tz: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')!.value.toLowerCase().slice(0, 3) as (typeof DAYS)[number];
  const hh = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')!.value);
  const cur = hh * 60 + mm;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const today = hours[wd];
  if (today) {
    const o = toMin(today.open);
    const c = toMin(today.close);
    if (o <= c ? cur >= o && cur < c : cur >= o || cur < c) return true;
  }
  // интервал вчерашнего дня через полночь
  const yd = hours[DAYS[(DAYS.indexOf(wd) + 6) % 7]!];
  if (yd && toMin(yd.open) > toMin(yd.close) && cur < toMin(yd.close)) return true;
  return false;
}
