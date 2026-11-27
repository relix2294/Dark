import { describe, expect, it } from 'vitest';
import { dishColor, scheduleOrder, type StationLoad } from './schedule.js';

const now = new Date('2026-11-27T12:00:00Z');
const idle: StationLoad = {
  pizza: { inProgress: 0, capacity: 4, queuedSec: 0 },
  grill: { inProgress: 0, capacity: 6, queuedSec: 0 },
  cold: { inProgress: 0, capacity: 8, queuedSec: 0 },
  pack: { inProgress: 0, capacity: 10, queuedSec: 0 },
};

describe('раскладка заказа на кухне (ТЗ §8)', () => {
  it('все блюда готовы одновременно: салат стартует позже пиццы', () => {
    const r = scheduleOrder(
      now,
      [
        { orderItemId: 'p', station: 'pizza', cookTimeSec: 900 },
        { orderItemId: 's', station: 'cold', cookTimeSec: 180 },
      ],
      idle,
    );
    expect(r.targetReadyAt.toISOString()).toBe('2026-11-27T12:15:00.000Z');
    expect(r.dishes.find((d) => d.orderItemId === 'p')?.startAt.toISOString()).toBe('2026-11-27T12:00:00.000Z');
    expect(r.dishes.find((d) => d.orderItemId === 's')?.startAt.toISOString()).toBe('2026-11-27T12:12:00.000Z');
  });
  it('полная печь сдвигает готовность на очередь станции', () => {
    const load = { ...idle, pizza: { inProgress: 4, capacity: 4, queuedSec: 300 } };
    const r = scheduleOrder(now, [{ orderItemId: 'p', station: 'pizza', cookTimeSec: 900 }], load);
    expect(r.targetReadyAt.toISOString()).toBe('2026-11-27T12:20:00.000Z');
  });
  it('цвета блюда', () => {
    const d = { startAt: new Date('2026-11-27T12:05:00Z'), targetReadyAt: new Date('2026-11-27T12:15:00Z') };
    expect(dishColor(now, d, null)).toBe('grey');
    expect(dishColor(new Date('2026-11-27T12:10:00Z'), d, null)).toBe('yellow');
    expect(dishColor(new Date('2026-11-27T12:16:00Z'), d, null)).toBe('red');
    expect(dishColor(now, d, now)).toBe('done');
  });
});
