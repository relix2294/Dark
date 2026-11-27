import { z } from 'zod';
import { Station } from './enums.js';
import { Uuid } from './common.js';
import { ModifierSnapshot } from './modifiers.js';

export const KdsQueueQuery = z.object({ station: Station });
export const KdsItemIdParams = z.object({ id: Uuid });
export const KdsOrderIdParams = z.object({ id: Uuid });

export const StopListRequest = z.object({
  product_ids: z.array(Uuid).default([]),
  ingredient_ids: z.array(Uuid).default([]),
});
export const StopListView = z.object({ product_ids: z.array(Uuid), ingredient_ids: z.array(Uuid) });

export const KdsColor = z.enum(['grey', 'yellow', 'red', 'done']);

export const KdsItemView = z.object({
  id: Uuid,
  order_id: Uuid,
  order_number: z.string(),
  name: z.string(),
  qty: z.number().int(),
  modifiers: ModifierSnapshot.nullable(),
  station: Station,
  cook_time_sec: z.number().int(),
  start_at: z.iso.datetime(),
  target_ready_at: z.iso.datetime(),
  started_at: z.iso.datetime().nullable(),
  done_at: z.iso.datetime().nullable(),
  color: KdsColor,
});
export const KdsQueueView = z.object({ station: Station, now: z.iso.datetime(), items: z.array(KdsItemView) });

/** Станция pack видит заказ целиком. */
export const KdsPackOrderView = z.object({
  order_id: Uuid,
  order_number: z.string(),
  target_ready_at: z.iso.datetime().nullable(),
  items: z.array(KdsItemView),
  all_done: z.boolean(),
});
export const KdsPackListView = z.object({ orders: z.array(KdsPackOrderView) });
export const PackedView = z.object({ order_number: z.string(), barcode: z.string() });
