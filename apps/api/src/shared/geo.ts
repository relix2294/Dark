export type Geo = { lat: number; lon: number };

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Расстояние по прямой, метры (haversine). */
export function distanceM(a: Geo, b: Geo): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Точка в полигоне (ray casting). Полигон — [lon, lat][] как в GeoJSON. */
export function pointInPolygon(p: Geo, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const intersects = yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Скорость транспорта, м/мин. Первый этап: прямая × 1,4 (ТЗ §6). */
export const SPEED_M_PER_MIN: Record<'foot' | 'bike' | 'moto', number> = { foot: 80, bike: 230, moto: 400 };
export const ROAD_FACTOR = 1.4;

export function travelMinutes(from: Geo, to: Geo, transport: keyof typeof SPEED_M_PER_MIN): number {
  return (distanceM(from, to) * ROAD_FACTOR) / SPEED_M_PER_MIN[transport];
}
