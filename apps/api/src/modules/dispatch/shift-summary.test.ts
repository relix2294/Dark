import { describe, expect, it } from 'vitest';
import { pathKm, type TrackPoint } from './shift-summary.js';

const t0 = Date.parse('2026-11-27T07:00:00Z');
const pt = (lat: number, lon: number, sec: number, accuracyM = 10): TrackPoint => ({ lat, lon, at: new Date(t0 + sec * 1000), accuracyM });

describe('пробег по треку', () => {
  it('сумма отрезков, округление до 0,1 км', () => {
    // ~1,11 км на север за 4 минуты и обратно
    expect(pathKm([pt(38.56, 68.78, 0), pt(38.57, 68.78, 240), pt(38.56, 68.78, 480)])).toBe(2.2);
    expect(pathKm([])).toBe(0);
  });
  it('неточные точки и скачки быстрее 90 км/ч не считаются', () => {
    const jump = pt(38.66, 68.78, 60); // 11 км за минуту — сбой GPS
    const fuzzy = pt(38.60, 68.78, 120, 300);
    expect(pathKm([pt(38.56, 68.78, 0), jump, fuzzy, pt(38.57, 68.78, 240)])).toBe(1.1);
  });
});
