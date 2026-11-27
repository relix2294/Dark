import { z } from 'zod';
import { Dirams, Qty } from './money.js';
import { Uuid } from './common.js';
import { OrderItemStatus, TempZone } from './enums.js';

export const TaskIdParams = z.object({ id: Uuid });
export const SupplyIdParams = z.object({ id: Uuid });

export const PickItemView = z.object({
  order_item_id: Uuid,
  product_id: Uuid,
  name: z.string(),
  barcodes: z.array(z.string()),
  is_weighted: z.boolean(),
  temp_zone: TempZone,
  qty_ordered: Qty,
  qty_picked: Qty,
  status: OrderItemStatus,
  /** Замена по звонку клиенту: до этого момента сборщик ждёт решения, потом позиция остаётся убранной (ТЗ §11). */
  call_deadline: z.iso.datetime().nullable(),
  /** Блюдо кухни в заказе Lablabu: не со склада, а со станции; ready — кухня отметила готовность. */
  kitchen: z.object({ ready: z.boolean(), station: z.string() }).nullable(),
  /** Ячейки, где зарезервирован товар, в порядке обхода. */
  cells: z.array(z.object({ cell_code: z.string(), qty: Qty, pick_seq: z.number().int() })),
});

export const PickTaskView = z.object({
  task_id: Uuid,
  order_id: Uuid,
  order_number: z.string(),
  started_at: z.iso.datetime(),
  sla_ms: z.number().int(),
  comment: z.string(),
  items: z.array(PickItemView),
});
export type PickTaskView = z.infer<typeof PickTaskView>;

export const PickLabelView = z.object({
  order_number: z.string(),
  barcode: z.string(),
  temp_zones: z.array(TempZone),
  items_total_dirams: Dirams,
});

export const MissingDecision = z.object({
  order_item_id: Uuid,
  /** Переопределить политику заказа (например, клиент по телефону согласился на удаление). */
  decision: z.enum(['auto', 'remove']).optional(),
});

export const StockLotView = z.object({
  lot_id: Uuid,
  product_id: Uuid,
  cell_code: z.string().nullable(),
  qty: Qty,
  reserved_qty: Qty,
  expires_at: z.iso.datetime().nullable(),
});

export const PlaceSuggestion = z.object({
  lot_id: Uuid,
  suggested: z.array(z.object({ cell_code: z.string(), free_units: z.number().int(), pick_seq: z.number().int() })),
});

export const SupplyView = z.object({
  id: Uuid,
  supplier: z.string(),
  status: z.string(),
  items: z.array(
    z.object({ product_id: Uuid, name: z.string(), barcodes: z.array(z.string()), qty_expected: Qty, qty_received: Qty }),
  ),
});

export const StocktakeIdParams = z.object({ id: Uuid });

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
export const StocktakeLineView = z.object({ cell_code: z.string(), product_id: Uuid, qty_system: Qty, qty_fact: Qty.nullable(), recount_required: z.boolean() });
