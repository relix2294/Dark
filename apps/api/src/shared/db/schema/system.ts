import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { base, ts } from './_common.js';
import { stationEnum } from './enums.js';
import { store } from './refs.js';
import { order, orderItem } from './orders.js';

/**
 * Outbox: событие пишется в той же транзакции, что и изменение; отдельный процесс доставляет (ТЗ §10).
 */
export const outbox = pgTable(
  'outbox',
  {
    ...base,
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    publishedAt: ts('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.createdAt)],
);

/** Ответ изменяющего запроса по Idempotency-Key: повтор возвращает первый результат (ТЗ §1). */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    ...base,
    key: text('key').notNull(),
    /** Ключ действует в рамках субъекта (клиент или сотрудник), чужой ключ не подменить. */
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    lockedAt: ts('locked_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [uniqueIndex('idempotency_scope_key_uq').on(t.scope, t.key)],
);

/** Настраиваемые параметры по точке (ТЗ §12). store_id = null — значение по умолчанию. */
export const parameter = pgTable(
  'parameter',
  {
    ...base,
    storeId: uuid('store_id').references(() => store.id),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    editedBy: text('edited_by'),
  },
  (t) => [uniqueIndex('parameter_store_key_uq').on(t.storeId, t.key)],
);

/** Неизменяемый журнал: кто, когда, действие, объект, было, стало, причина. Хранение 3 года (ТЗ §10). */
export const auditLog = pgTable(
  'audit_log',
  {
    ...base,
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    storeId: uuid('store_id'),
  },
  (t) => [index('audit_log_object_idx').on(t.objectType, t.objectId), index('audit_log_created_idx').on(t.createdAt)],
);

/** Блюдо в очереди кухни (ТЗ §8). */
export const kdsItem = pgTable(
  'kds_item',
  {
    ...base,
    orderId: uuid('order_id').notNull().references(() => order.id),
    orderItemId: uuid('order_item_id').notNull().references(() => orderItem.id),
    storeId: uuid('store_id').notNull().references(() => store.id),
    station: stationEnum('station').notNull(),
    cookTimeSec: integer('cook_time_sec').notNull(),
    startAt: ts('start_at').notNull(),
    targetReadyAt: ts('target_ready_at').notNull(),
    startedAt: ts('started_at'),
    doneAt: ts('done_at'),
  },
  (t) => [index('kds_item_store_station_idx').on(t.storeId, t.station, t.startAt)],
);

export const stopList = pgTable(
  'stop_list',
  {
    ...base,
    storeId: uuid('store_id').notNull().references(() => store.id),
    productId: uuid('product_id'),
    ingredientId: uuid('ingredient_id'),
    setBy: text('set_by'),
    clearedAt: ts('cleared_at'),
  },
  (t) => [index('stop_list_store_idx').on(t.storeId, t.clearedAt)],
);
