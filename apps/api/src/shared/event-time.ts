import { AppError } from './errors/index.js';

/** Действие из очереди без связи старше суток не принимаем — его время уже ничего не значит для расчётов. */
const EVENT_MAX_AGE_MS = 24 * 3600_000;

/**
 * Время события с устройства (ТЗ §11: терминал, кухня и курьер работают без связи; сервер принимает события
 * по времени события, а не получения). Без at — сейчас. Из будущего (часы устройства спешат) — сейчас.
 * Раньше предыдущего шага (floor) — время шага: порядок шагов не нарушается.
 */
export function eventTime(now: Date, raw: string | undefined, floor?: Date | null): Date {
  if (!raw) return now;
  const t = new Date(raw);
  if (now.getTime() - t.getTime() > EVENT_MAX_AGE_MS) throw new AppError('VALIDATION', 'Событие старше суток — подтвердит старший смены', { at: raw });
  if (t > now) return now;
  if (floor && t < floor) return floor;
  return t;
}
