import { z } from 'zod';
import { Geo, Uuid } from './common.js';
import { Brand, CourierStatus, DeliveryTaskStatus, OrderStatus, TempZone, Transport } from './enums.js';
import { Dirams } from './money.js';

export const PositionBatch = z.object({
  points: z
    .array(Geo.extend({ at: z.iso.datetime(), accuracy_m: z.number().min(0) }))
    .min(1)
    .max(500),
});
/** Время события на устройстве: действие могло копиться без связи (ТЗ §11 — сервер принимает по времени события). */
const EventAt = z.iso.datetime().optional();
export const DeliveredRequest = z.object({ geo: Geo, photo_url: z.string().optional(), at: EventAt });
export const PickupRequest = z.object({ package_barcodes: z.array(z.string()).min(1), at: EventAt });
export const NoShowRequest = z.object({ calls: z.number().int().min(0).default(2), comment: z.string().max(200).optional(), at: EventAt });
export const ShiftStartRequest = z.object({ transport: Transport.optional() });
export const CourierTaskIdParams = z.object({ id: Uuid });
export const CourierOrderIdParams = z.object({ id: Uuid });

export const CourierSelfView = z.object({
  courier_id: Uuid,
  status: CourierStatus,
  transport: Transport,
  store_id: Uuid.nullable(),
  shift_started_at: z.iso.datetime().nullable(),
  /** Заработок за смену: доставок и сумма (модель оплаты не утверждена — пока число доставок). */
  deliveries_today: z.number().int(),
});

export const TaskOrderView = z.object({
  order_id: Uuid,
  number: z.string(),
  brand: Brand,
  status: OrderStatus,
  package_barcode: z.string(),
  temp_zones: z.array(TempZone),
  address: z.object({ street: z.string(), house: z.string(), entrance: z.string().nullable(), floor: z.string().nullable(), flat: z.string().nullable(), comment: z.string().nullable(), geo: Geo }),
  /** Маскированный телефон; звонок — через скрытый номер (этап 2). */
  customer_phone_masked: z.string().nullable(),
  promised_at: z.iso.datetime().nullable(),
  total_dirams: Dirams,
});

export const DeliveryTaskView = z.object({
  task_id: Uuid,
  status: DeliveryTaskStatus,
  store: z.object({ id: Uuid, name: z.string(), address: z.string(), geo: Geo }),
  assigned_at: z.iso.datetime(),
  offer_expires_at: z.iso.datetime().nullable(),
  orders: z.array(TaskOrderView),
});
export type DeliveryTaskView = z.infer<typeof DeliveryTaskView>;

/** Итоги смены курьера: время, поездки, доставки, пробег. Денег нет, пока не утверждена модель оплаты. */
export const ShiftSummaryView = z.object({
  shift_started_at: z.iso.datetime(),
  shift_ended_at: z.iso.datetime().nullable(),
  minutes: z.number().int(),
  trips: z.number().int(),
  delivered: z.number().int(),
  on_time: z.number().int(),
  returned: z.number().int(),
  avg_delivery_min: z.number().int().nullable(),
  km: z.number(),
});
