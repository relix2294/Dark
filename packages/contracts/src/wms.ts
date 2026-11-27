import { z } from 'zod';
import { Qty } from './money.js';
import { Uuid } from './common.js';

export const PickScanRequest = z.object({
  cell_code: z.string().min(1),
  barcode: z.string().min(1),
  qty: Qty.min(1),
  weight_g: z.number().int().min(1).optional(),
});
export const PickMissingRequest = z.object({ order_item_id: Uuid });
export const ReceiveRequest = z.object({
  barcode: z.string().min(1),
  qty: Qty.min(1),
  expires_at: z.iso.date().optional(),
});
export const PlaceRequest = z.object({ lot_id: Uuid, cell_code: z.string().min(1), qty: Qty.min(1) });
export const WriteOffRequest = z.object({
  lot_id: Uuid,
  qty: Qty.min(1),
  reason: z.string().min(1).max(200),
  photo_url: z.string().optional(),
});
export const StocktakeCountRequest = z.object({ cell_code: z.string(), product_id: Uuid, qty_fact: Qty });
