import { z } from 'zod';
import { Geo, Uuid } from './common.js';
import { Brand, CourierStatus, DeviceApp, DispatchReason, OrderStatus, Transport } from './enums.js';
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
  geo: Geo.nullable(),
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

const ReasonFields = { reason_code: DispatchReason, comment: z.string().trim().max(200).optional() };
const commentForOther = (r: { reason_code: string; comment?: string | undefined }) => r.reason_code !== 'other' || !!r.comment;
const otherNeedsComment = { message: 'Для причины «другое» нужен комментарий', path: ['comment'] };
/** Назначить или переназначить курьера вручную: причина из списка (ТЗ §6). */
export const ManualAssignRequest = z.object({ courier_id: Uuid, ...ReasonFields }).refine(commentForOther, otherNeedsComment);
/** Снять заказ с курьера: заказ возвращается в очередь диспетчера (ТЗ §6). */
export const UnassignRequest = z.object(ReasonFields).refine(commentForOther, otherNeedsComment);
export const StaffCancelRequest = z.object({ reason: z.string().min(1).max(200) });
export const ReturnedRequest = z.object({ comment: z.string().max(200).optional() });
export const RefundRequest = z.object({ amount_dirams: Dirams.min(1), reason: z.string().min(1).max(200) });
export const RefundView = z.object({ payment_status: z.string(), refunded_dirams: Dirams, captured_dirams: Dirams });

export const LeadDeliveredRequest = z.object({ reason: z.string().min(1).max(200) });

/** Лента тревог пульта (ТЗ §9–10): события, требующие внимания старшего смены. */
export const ConsoleAlertLevel = z.enum(['critical', 'warning', 'info']);
export const ConsoleAlertView = z.object({
  id: Uuid,
  topic: z.string(),
  level: ConsoleAlertLevel,
  text: z.string(),
  order_id: Uuid.nullable(),
  order_number: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export const ConsoleAlertsView = z.object({ alerts: z.array(ConsoleAlertView) });
export const ConsoleAlertsQuery = z.object({ hours: z.coerce.number().int().min(1).max(72).default(12) });

/** Пульс устройства раз в 30 с; bye — штатный выход (конец смены), тревоги не будет. */
export const HeartbeatRequest = z.object({ device_id: z.string().min(8).max(64), app: DeviceApp, bye: z.boolean().optional() });
export const ConsoleDeviceView = z.object({
  device_id: z.string(),
  app: DeviceApp,
  staff_name: z.string().nullable(),
  last_seen_at: z.iso.datetime(),
  online: z.boolean(),
});
export const ConsoleDevicesView = z.object({ devices: z.array(ConsoleDeviceView) });
