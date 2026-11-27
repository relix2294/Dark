import { describe, expect, it } from 'vitest';
import { distanceM, pointInPolygon, travelMinutes } from './geo.js';

const dushanbe = { lat: 38.5598, lon: 68.787 };
describe('geo', () => {
  it('haversine ~ 1.1 км', () => {
    const d = distanceM(dushanbe, { lat: 38.5698, lon: 68.787 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });
  it('точка в полигоне / вне', () => {
    const poly: [number, number][] = [
      [68.7, 38.5],
      [68.9, 38.5],
      [68.9, 38.6],
      [68.7, 38.6],
    ];
    expect(pointInPolygon(dushanbe, poly)).toBe(true);
    expect(pointInPolygon({ lat: 38.7, lon: 68.8 }, poly)).toBe(false);
  });
  it('время в пути с коэффициентом дороги', () => {
    const m = travelMinutes(dushanbe, { lat: 38.5698, lon: 68.787 }, 'bike');
    expect(m).toBeGreaterThan(6);
    expect(m).toBeLessThan(7.5);
  });
});
