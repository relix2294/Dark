import { z } from 'zod';
import { Geo, Uuid } from './common.js';
import { Brand, CourierStatus, OrderStatus, Transport } from './enums.js';
import { Dirams } from './money.js';

/** Пульт старшего смены (ТЗ §9). */
export const ConsoleStoreParams = z.object({ store_id: Uuid });
export const ConsoleOrderParams = z.object({ store_id: Uuid, id: Uuid });

export const ConsoleOrderView = z.object({
  id: Uuid,
  number: z.string(),
  brand: Brand,
  status: OrderStatus,
  total_dirams: Dirams,
  created_at: z.iso.datetime(),
  promised_at: z.iso.datetime().nullable(),
  ready_at: z.iso.datetime().nullable(),
  courier: z.object({ courier_id: Uuid, name: z.string(), task_status: z.string() }).nullable(),
  /** Минут ожидания курьера для ready-заказов без курьера. */
  waiting_min: z.number().nullable(),
  address_short: z.string(),
});
export const ConsoleOrdersView = z.object({ orders: z.array(ConsoleOrderView) });

export const ConsoleCourierView = z.object({
  courier_id: Uuid,
  name: z.string(),
  status: CourierStatus,
  transport: Transport,
  position: Geo.nullable(),
  position_at: z.iso.datetime().nullable(),
  current_task_id: Uuid.nullable(),
});
export const ConsoleCouriersView = z.object({ couriers: z.array(ConsoleCourierView) });

export const ManualAssignRequest = z.object({ courier_id: Uuid, reason: z.string().min(1).max(200) });
export const StaffCancelRequest = z.object({ reason: z.string().min(1).max(200) });
export const ReturnedRequest = z.object({ comment: z.string().max(200).optional() });
export const RefundRequest = z.object({ amount_dirams: Dirams.min(1), reason: z.string().min(1).max(200) });
export const RefundView = z.object({ payment_status: z.string(), refunded_dirams: Dirams, captured_dirams: Dirams });
