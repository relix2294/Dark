import { z } from 'zod';

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime();

export const Geo = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Geo = z.infer<typeof Geo>;

/** Заголовок идемпотентности обязателен для всех изменяющих запросов (ТЗ §1). */
export const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().min(8).max(128),
});
