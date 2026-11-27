import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, fromLocations, takeBatch, type Point } from './queue.ts';

const p = (i: number): Point => ({ lat: 38.5 + i / 1e4, lon: 68.7, at: new Date(Date.UTC(2026, 10, 27, 12, 0, i)).toISOString(), accuracy_m: 5 });

test('очередь: по времени, без дублей, старые выкидываются сверх лимита', () => {
  const q = enqueue([p(3), p(1)], [p(2), p(1)], 2);
  assert.deepEqual(q.map((x) => x.at), [p(2).at, p(3).at]);
});

test('пакеты по 500', () => {
  const q = enqueue([], Array.from({ length: 1200 }, (_, i) => p(i)));
  const { batch, rest } = takeBatch(q);
  assert.equal(batch.length, 500);
  assert.equal(rest.length, 700);
  assert.equal(batch[0]!.at, p(0).at);
});

test('точки из expo-location, мусор отбрасывается', () => {
  const pts = fromLocations([{ coords: { latitude: 38.56, longitude: 68.78, accuracy: null }, timestamp: Date.UTC(2026, 10, 27) }]);
  assert.deepEqual(pts, [{ lat: 38.56, lon: 68.78, at: '2026-11-27T00:00:00.000Z', accuracy_m: 0 }]);
  assert.equal(enqueue([], [{ lat: NaN, lon: 1, at: 'x', accuracy_m: 1 }]).length, 0);
});
