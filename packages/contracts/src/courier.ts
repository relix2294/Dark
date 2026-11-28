import { z } from 'zod';
import { Geo, Uuid } from './common.js';
import { Brand, CourierStatus, DeliveryTaskStatus, OrderStatus, TempZone, Transport, PayoutKind, PayoutStatus } from './enums.js';
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
  /** Маскированный телефон для узнавания («+992 ** *** 12 34»); звонить — только через call_number. */
  customer_phone_masked: z.string().nullable(),
  /** Подменный номер клиента на время доставки: набирается и без связи с сервером. */
  call_number: z.string().nullable(),
  /** Звонков клиенту через подменный номер и время первого — «клиент не вышел» после 2 звонков и ожидания. */
  calls_made: z.number().int(),
  first_call_at: z.iso.datetime().nullable(),
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
  /** Начисление по тарифу точки: за доставку, километр, час. Выплата — на кошелёк DC после закрытия смены. */
  pay: z.object({
    per_delivery_dirams: Dirams,
    per_km_dirams: Dirams,
    per_hour_dirams: Dirams,
    deliveries_dirams: Dirams,
    km_dirams: Dirams,
    hours_dirams: Dirams,
    total_dirams: Dirams,
  }),
  /** Статус выплаты закрытой смены; null — смена ещё идёт. */
  payout_status: PayoutStatus.nullable(),
});

export const CourierPayoutView = z.object({
  id: Uuid,
  kind: PayoutKind,
  amount_dirams: Dirams,
  status: PayoutStatus,
  reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  sent_at: z.iso.datetime().nullable(),
});
export const CourierPayoutListView = z.object({ payouts: z.array(CourierPayoutView) });

/** Позвонить через подменный номер: at — время нажатия, если запрос ждал связи. */
export const CallRequest = z.object({ at: z.iso.datetime().optional() });
/** Номер, который набирает телефон: подменный, настоящий номер собеседника не раскрывается. */
export const CallView = z.object({ dial: z.string() });
