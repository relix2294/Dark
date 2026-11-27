import { describe, expect, it } from 'vitest';
import { isOpenAt } from './hours.js';

const tz = 'Asia/Dushanbe'; // UTC+5
describe('часы работы', () => {
  const hours = { thu: { open: '08:00', close: '23:00' }, fri: { open: '20:00', close: '02:00' } };
  it('внутри интервала', () => expect(isOpenAt(hours, new Date('2026-11-26T05:00:00Z'), tz)).toBe(true)); // чт 10:00
  it('до открытия', () => expect(isOpenAt(hours, new Date('2026-11-26T02:00:00Z'), tz)).toBe(false)); // чт 07:00
  it('через полночь — пятница 23:30', () => expect(isOpenAt(hours, new Date('2026-11-27T18:30:00Z'), tz)).toBe(true));
  it('через полночь — суббота 01:00 (вчерашний интервал)', () => expect(isOpenAt(hours, new Date('2026-11-27T20:00:00Z'), tz)).toBe(true));
  it('день без расписания', () => expect(isOpenAt(hours, new Date('2026-11-29T08:00:00Z'), tz)).toBe(false));
});
