import { z } from 'zod';
import { Brand, OrderItemStatus, OrderStatus, ReplacePolicy } from './enums.js';
import { Dirams, Qty } from './money.js';
import { Geo, Uuid } from './common.js';

export const CartItemInput = z.object({
  product_id: Uuid,
  qty: Qty.min(1),
  replace_policy: ReplacePolicy.default('call'),
  modifiers: z.record(z.string(), z.unknown()).optional(),
});

export const CartRequest = z.object({
  brand: Brand,
  store_id: Uuid,
  address_id: Uuid.optional(),
  items: z.array(CartItemInput).min(1).max(100),
  promo_code: z.string().max(32).optional(),
});

export const CartLine = z.object({
  product_id: Uuid,
  name: z.string(),
  qty: Qty,
  price_dirams: Dirams,
  line_total_dirams: Dirams,
  available: z.boolean(),
});

/** Пересчитанная корзина — ответ PUT /cart и тело 409 PRICE_CHANGED. */
export const CartResponse = z.object({
  lines: z.array(CartLine),
  unavailable_product_ids: z.array(Uuid),
  items_total_dirams: Dirams,
  delivery_fee_dirams: Dirams,
  discount_dirams: Dirams,
  total_dirams: Dirams,
  promo_applied: z.string().nullable(),
  promo_error: z.string().nullable(),
});
export type CartResponse = z.infer<typeof CartResponse>;

/** POST /orders (ТЗ §4). */
export const CreateOrderRequest = CartRequest.extend({
  address_id: Uuid,
  expected_total_dirams: Dirams,
  comment: z.string().max(500).default(''),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const OrderItemView = z.object({
  id: Uuid,
  product_id: Uuid,
  name_snapshot: z.string(),
  qty_ordered: Qty,
  qty_picked: Qty,
  price_dirams: Dirams,
  status: OrderItemStatus,
  replaced_by_item_id: Uuid.nullable(),
});

export const CourierView = z.object({
  name: z.string(),
  position: Geo.nullable(),
});

export const OrderView = z.object({
  id: Uuid,
  number: z.string(),
  brand: Brand,
  store_id: Uuid,
  status: OrderStatus,
  items: z.array(OrderItemView),
  items_total_dirams: Dirams,
  delivery_fee_dirams: Dirams,
  discount_dirams: Dirams,
  total_dirams: Dirams,
  captured_dirams: Dirams.nullable(),
  promised_at: z.iso.datetime().nullable(),
  ready_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  courier: CourierView.nullable(),
  created_at: z.iso.datetime(),
});
export type OrderView = z.infer<typeof OrderView>;

export const CancelOrderRequest = z.object({ reason: z.string().max(200).optional() });

export const OrderIdParams = z.object({ id: Uuid });

export const OrderListView = z.object({ orders: z.array(OrderView) });

export const AddressCreate = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  street: z.string().min(1).max(120),
  house: z.string().min(1).max(20),
  entrance: z.string().max(10).optional(),
  floor: z.string().max(10).optional(),
  flat: z.string().max(10).optional(),
  comment: z.string().max(200).optional(),
});
export const AddressView = AddressCreate.extend({ id: Uuid, entrance: z.string().nullable(), floor: z.string().nullable(), flat: z.string().nullable(), comment: z.string().nullable() });
export const AddressListView = z.object({ addresses: z.array(AddressView) });
