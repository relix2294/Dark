import { describe, expect, it } from 'vitest';
import { tryAddToTrip, type TripOrder } from './batch.js';

const now = new Date('2026-11-27T12:00:00Z');
const store = { lat: 38.56, lon: 68.78 };
const m = (n: number) => new Date(now.getTime() + n * 60_000);
const P = { BATCH_MAX: 2, BATCH_DETOUR_MS: 4 * 60_000 };
// ~0.56 км к северу и соседний дом
const a = { lat: 38.565, lon: 68.78 };
const aNext = { lat: 38.5655, lon: 68.7805 };
const far = { lat: 38.58, lon: 68.82 };

const lab = (id: string, addr = a, ready = 1, promise = 15): TripOrder => ({ id, brand: 'LAB', readyEta: m(ready), promisedAt: m(promise), address: addr });
const sor = (id: string, addr = aNext, ready = 1, promise = 45): TripOrder => ({ id, brand: 'SOR', readyEta: m(ready), promisedAt: m(promise), address: addr });

describe('объединение поездок (ТЗ §6, этап 2)', () => {
  it('два LAB к соседним домам — да', () => {
    const r = tryAddToTrip(store, [lab('L1')], lab('L2', aNext), 'bike', now, P);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.seq.map((o) => o.id)).toEqual(['L1', 'L2']);
  });
  it('второй LAB далеко — крюк больше BATCH_DETOUR', () => {
    expect(tryAddToTrip(store, [lab('L1')], lab('L2', far), 'bike', now, P)).toEqual({ ok: false, reason: 'detour' });
  });
  it('LAB готовы с разницей больше 2 минут — нет', () => {
    expect(tryAddToTrip(store, [lab('L1', a, 1)], lab('L2', aNext, 5), 'bike', now, P)).toMatchObject({ ok: false, reason: 'lab_ready_gap' });
  });
  it('LAB + SOR: LAB везут первым, даже если SOR был в поездке раньше', () => {
    const r = tryAddToTrip(store, [sor('S1')], lab('L1'), 'bike', now, P);
    expect(r.ok && r.seq.map((o) => o.id)).toEqual(['L1', 'S1']);
  });
  it('SOR теряет больше 5 минут — нет', () => {
    // LAB готов только через 10 минут, SOR готов сейчас: ждать LAB = потеря ~9 минут
    expect(tryAddToTrip(store, [sor('S1', aNext, 0)], lab('L1', a, 10, 25), 'bike', now, P)).toMatchObject({ ok: false, reason: 'sor_loss' });
  });
  it('два SOR не объединяются, лимит BATCH_MAX', () => {
    expect(tryAddToTrip(store, [sor('S1')], sor('S2'), 'bike', now, P)).toMatchObject({ ok: false, reason: 'sor_sor' });
    expect(tryAddToTrip(store, [lab('L1'), lab('L2', aNext)], lab('L3'), 'bike', now, { ...P, BATCH_MAX: 2 })).toMatchObject({ ok: false, reason: 'batch_max' });
  });
  it('обещание первого LAB нарушается — нет', () => {
    // первый уже почти опаздывает: обещание через 4 мин, путь ~3.4 мин; второй добавляет подъезд
    const r = tryAddToTrip(store, [lab('L2', aNext, 0, 5)], lab('L1', a, 0, 3.5), 'bike', now, P);
    expect(r).toMatchObject({ ok: false, reason: 'promise' });
  });
});
