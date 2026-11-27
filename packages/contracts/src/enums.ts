import { z } from 'zod';

/** Бренды. Бренд — поле данных, не отдельная инсталляция (ТЗ §1). */
export const BRAND_VALUES = ['LAB', 'SOR'] as const;
export const Brand = z.enum(BRAND_VALUES);
export type Brand = z.infer<typeof Brand>;

/** Машина состояний заказа (ТЗ §3). */
export const ORDER_STATUS_VALUES = [
  'created',
  'paid_hold',
  'payment_failed',
  'picking',
  'cooking',
  'ready',
  'on_the_way',
  'delivered',
  'returning',
  'returned',
  'cancelled',
] as const;
export const OrderStatus = z.enum(ORDER_STATUS_VALUES);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const ORDER_ITEM_STATUS_VALUES = ['pending', 'picked', 'replaced', 'missing'] as const;
export const OrderItemStatus = z.enum(ORDER_ITEM_STATUS_VALUES);
export type OrderItemStatus = z.infer<typeof OrderItemStatus>;

export const REPLACE_POLICY_VALUES = ['call', 'auto', 'remove'] as const;
export const ReplacePolicy = z.enum(REPLACE_POLICY_VALUES);
export type ReplacePolicy = z.infer<typeof ReplacePolicy>;

/** Машина состояний платежа (ТЗ §3). */
export const PAYMENT_STATUS_VALUES = [
  'new',
  'hold_pending',
  'held',
  'failed',
  'released',
  'capture_pending',
  'captured',
  'refund_pending',
  'refunded',
  'partially_refunded',
] as const;
export const PaymentStatus = z.enum(PAYMENT_STATUS_VALUES);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PAYMENT_OP_TYPE_VALUES = ['hold', 'capture', 'release', 'refund'] as const;
export const PaymentOpType = z.enum(PAYMENT_OP_TYPE_VALUES);
export type PaymentOpType = z.infer<typeof PaymentOpType>;

/** Задание курьера (ТЗ §3). */
export const DELIVERY_TASK_STATUS_VALUES = [
  'offered',
  'expired',
  'accepted',
  'reassigned',
  'at_store',
  'picked_up',
  'delivering',
  'failed',
  'done',
] as const;
export const DeliveryTaskStatus = z.enum(DELIVERY_TASK_STATUS_VALUES);
export type DeliveryTaskStatus = z.infer<typeof DeliveryTaskStatus>;

export const COURIER_STATUS_VALUES = ['offline', 'free', 'assigned', 'delivering', 'returning', 'break'] as const;
export const CourierStatus = z.enum(COURIER_STATUS_VALUES);
export type CourierStatus = z.infer<typeof CourierStatus>;

export const TRANSPORT_VALUES = ['foot', 'bike', 'moto'] as const;
export const Transport = z.enum(TRANSPORT_VALUES);
export type Transport = z.infer<typeof Transport>;

export const TEMP_ZONE_VALUES = ['ambient', 'chill', 'frozen'] as const;
export const TempZone = z.enum(TEMP_ZONE_VALUES);
export type TempZone = z.infer<typeof TempZone>;

export const STATION_VALUES = ['pizza', 'grill', 'cold', 'pack'] as const;
export const Station = z.enum(STATION_VALUES);
export type Station = z.infer<typeof Station>;

export const STOCK_MOVE_TYPE_VALUES = [
  'receive',
  'place',
  'reserve',
  'pick',
  'unreserve',
  'write_off',
  'return',
  'adjust',
] as const;
export const StockMoveType = z.enum(STOCK_MOVE_TYPE_VALUES);
export type StockMoveType = z.infer<typeof StockMoveType>;

export const PROMO_TYPE_VALUES = ['free_delivery', 'percent', 'fixed'] as const;
export const PromoType = z.enum(PROMO_TYPE_VALUES);
export type PromoType = z.infer<typeof PromoType>;

export const PROMO_AUDIENCE_VALUES = ['new', 'all', 'segment'] as const;
export const PromoAudience = z.enum(PROMO_AUDIENCE_VALUES);
export type PromoAudience = z.infer<typeof PromoAudience>;

/** Роли персонала — матрица прав в ТЗ §9. */
export const STAFF_ROLE_VALUES = [
  'picker',
  'cook',
  'courier',
  'shift_lead',
  'manager',
  'finance',
  'admin',
] as const;
export const StaffRole = z.enum(STAFF_ROLE_VALUES);
export type StaffRole = z.infer<typeof StaffRole>;

/** Кто инициировал переход статуса. */
export const ACTOR_TYPE_VALUES = ['customer', 'staff', 'system'] as const;
export const ActorType = z.enum(ACTOR_TYPE_VALUES);
export type ActorType = z.infer<typeof ActorType>;
