/**
 * Очередь точек геопозиции на устройстве (ТЗ §11: курьер без связи — события копятся с метками времени
 * и уходят при восстановлении; сервер принимает их по времени события). Чистые функции без React Native.
 */
export type Point = { lat: number; lon: number; at: string; accuracy_m: number };

/** Сколько точек храним: 5 с × 2000 ≈ почти 3 часа без связи; старые выкидываются первыми. */
export const QUEUE_MAX = 2000;
/** Сколько точек в одном запросе (сервер принимает до 500). */
export const BATCH_MAX = 500;

export function enqueue(queue: Point[], points: Point[], max = QUEUE_MAX): Point[] {
  const merged = [...queue, ...points].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  // один и тот же момент мог прийти дважды (повтор системы) — оставляем по одному
  const seen = new Set<string>();
  const unique = merged.filter((p) => (seen.has(p.at) ? false : (seen.add(p.at), true)));
  unique.sort((a, b) => a.at.localeCompare(b.at));
  return unique.length > max ? unique.slice(unique.length - max) : unique;
}

export function takeBatch(queue: Point[], n = BATCH_MAX): { batch: Point[]; rest: Point[] } {
  return { batch: queue.slice(0, n), rest: queue.slice(n) };
}

/** Точки из события expo-location. */
export function fromLocations(locs: { coords: { latitude: number; longitude: number; accuracy: number | null }; timestamp: number }[]): Point[] {
  return locs.map((l) => ({ lat: l.coords.latitude, lon: l.coords.longitude, at: new Date(l.timestamp).toISOString(), accuracy_m: Math.max(0, l.coords.accuracy ?? 0) }));
}
