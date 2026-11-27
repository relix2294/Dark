import { doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { base, ts } from './_common.js';
import { courierStatusEnum, deliveryTaskStatusEnum, transportEnum } from './enums.js';
import { store, userStaff } from './refs.js';

export const courier = pgTable('courier', {
  ...base,
  staffId: uuid('staff_id').notNull().unique().references(() => userStaff.id),
  transport: transportEnum('transport').notNull().default('bike'),
  status: courierStatusEnum('status').notNull().default('offline'),
  currentStoreId: uuid('current_store_id').references(() => store.id),
});

export const courierShift = pgTable('courier_shift', {
  ...base,
  courierId: uuid('courier_id').notNull().references(() => courier.id),
  storeId: uuid('store_id').notNull().references(() => store.id),
  plannedFrom: ts('planned_from'),
  plannedTo: ts('planned_to'),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
});

/** Хранить 30 дней — чистится задачей (ТЗ §2). */
export const courierPosition = pgTable(
  'courier_position',
  {
    ...base,
    courierId: uuid('courier_id').notNull().references(() => courier.id),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    at: ts('at').notNull(),
    accuracyM: doublePrecision('accuracy_m').notNull(),
  },
  (t) => [index('courier_position_courier_at_idx').on(t.courierId, t.at)],
);

export const deliveryTask = pgTable(
  'delivery_task',
  {
    ...base,
    courierId: uuid('courier_id').notNull().references(() => courier.id),
    storeId: uuid('store_id').notNull().references(() => store.id),
    status: deliveryTaskStatusEnum('status').notNull().default('offered'),
    orderIds: uuid('order_ids').array().notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
    pickedUpAt: ts('picked_up_at'),
    finishedAt: ts('finished_at'),
    assignedBy: text('assigned_by').notNull().default('auto'),
    overrideReason: text('override_reason'),
    /** Снимок входа диспетчера и выбранное правило — для разбора «почему пицца ждала» (ТЗ §6). */
    dispatchSnapshot: text('dispatch_snapshot'),
  },
  (t) => [index('delivery_task_courier_status_idx').on(t.courierId, t.status)],
);

export const courierPlan = pgTable('courier_plan', {
  ...base,
  storeId: uuid('store_id').notNull().references(() => store.id),
  date: text('date').notNull(),
  hour: integer('hour').notNull(),
  forecastOrdersLab: integer('forecast_orders_lab').notNull().default(0),
  forecastOrdersSor: integer('forecast_orders_sor').notNull().default(0),
  couriersNeeded: integer('couriers_needed').notNull().default(0),
  couriersPlanned: integer('couriers_planned').notNull().default(0),
  editedBy: text('edited_by'),
});
