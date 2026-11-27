import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { base, ts } from './_common.js';
import {
  actorTypeEnum,
  brandEnum,
  orderItemStatusEnum,
  orderStatusEnum,
  paymentOpTypeEnum,
  paymentStatusEnum,
  promoAudienceEnum,
  promoTypeEnum,
  ratingTagEnum,
  replacePolicyEnum,
} from './enums.js';
import { customer, product, store } from './refs.js';

export const order = pgTable(
  'order',
  {
    ...base,
    number: text('number').notNull().unique(),
    brand: brandEnum('brand').notNull(),
    storeId: uuid('store_id').notNull().references(() => store.id),
    customerId: uuid('customer_id').notNull().references(() => customer.id),
    addressSnapshot: jsonb('address_snapshot').$type<Record<string, unknown>>().notNull(),
    status: orderStatusEnum('status').notNull().default('created'),
    itemsTotalDirams: integer('items_total_dirams').notNull(),
    deliveryFeeDirams: integer('delivery_fee_dirams').notNull(),
    discountDirams: integer('discount_dirams').notNull().default(0),
    totalDirams: integer('total_dirams').notNull(),
    capturedDirams: integer('captured_dirams'),
    promisedAt: ts('promised_at'),
    readyAt: ts('ready_at'),
    deliveredAt: ts('delivered_at'),
    cancelReason: text('cancel_reason'),
    comment: text('comment').notNull().default(''),
  },
  (t) => [index('order_store_status_idx').on(t.storeId, t.status), index('order_customer_idx').on(t.customerId)],
);

export const orderItem = pgTable(
  'order_item',
  {
    ...base,
    orderId: uuid('order_id').notNull().references(() => order.id),
    productId: uuid('product_id').notNull().references(() => product.id),
    nameSnapshot: text('name_snapshot').notNull(),
    qtyOrdered: integer('qty_ordered').notNull(),
    qtyPicked: integer('qty_picked').notNull().default(0),
    priceDirams: integer('price_dirams').notNull(),
    status: orderItemStatusEnum('status').notNull().default('pending'),
    replacePolicy: replacePolicyEnum('replace_policy').notNull().default('call'),
    replacedByItemId: uuid('replaced_by_item_id'),
    /** Снимок выбранных модификаторов: [{group, options:[{name, price_dirams}]}]. */
    modifiers: jsonb('modifiers').$type<{ group: string; options: { name: string; price_dirams: number }[] }[]>(),
    /** Почему позиция missing/replaced и какое решение принято (call / auto / remove). */
    missingMeta: jsonb('missing_meta').$type<Record<string, unknown>>(),
  },
  (t) => [index('order_item_order_idx').on(t.orderId)],
);

export const orderStatusLog = pgTable(
  'order_status_log',
  {
    ...base,
    orderId: uuid('order_id').notNull().references(() => order.id),
    from: orderStatusEnum('from'),
    to: orderStatusEnum('to').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    at: ts('at').notNull().defaultNow(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [index('order_status_log_order_idx').on(t.orderId)],
);

export const payment = pgTable('payment', {
  ...base,
  orderId: uuid('order_id').notNull().unique().references(() => order.id),
  providerRef: text('provider_ref'),
  status: paymentStatusEnum('status').notNull().default('new'),
  holdDirams: integer('hold_dirams').notNull(),
  capturedDirams: integer('captured_dirams').notNull().default(0),
  refundedDirams: integer('refunded_dirams').notNull().default(0),
  holdExpiresAt: ts('hold_expires_at'),
  lastError: text('last_error'),
});

export const paymentOp = pgTable(
  'payment_op',
  {
    ...base,
    paymentId: uuid('payment_id').notNull().references(() => payment.id),
    type: paymentOpTypeEnum('type').notNull(),
    amountDirams: integer('amount_dirams').notNull(),
    /** {order_id}:{type}:{seq} — повтор не создаёт второго движения денег (ТЗ §5). */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'),
    providerResponse: jsonb('provider_response').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('payment_op_idem_uq').on(t.idempotencyKey)],
);

export const promo = pgTable('promo', {
  ...base,
  code: text('code').notNull().unique(),
  brand: brandEnum('brand'),
  type: promoTypeEnum('type').notNull(),
  value: integer('value').notNull(),
  audience: promoAudienceEnum('audience').notNull().default('all'),
  perCustomerLimit: integer('per_customer_limit').notNull().default(1),
  budgetDirams: integer('budget_dirams'),
  spentDirams: integer('spent_dirams').notNull().default(0),
  validFrom: ts('valid_from'),
  validTo: ts('valid_to'),
});

export const promoUse = pgTable(
  'promo_use',
  {
    ...base,
    promoId: uuid('promo_id').notNull().references(() => promo.id),
    customerId: uuid('customer_id').notNull().references(() => customer.id),
    orderId: uuid('order_id').notNull().references(() => order.id),
    amountDirams: integer('amount_dirams').notNull(),
  },
  (t) => [index('promo_use_promo_customer_idx').on(t.promoId, t.customerId)],
);

/** Оценка доставленного заказа клиентом (ТЗ §9): одна на заказ. */
export const orderRating = pgTable(
  'order_rating',
  {
    ...base,
    orderId: uuid('order_id').notNull().unique().references(() => order.id),
    customerId: uuid('customer_id').notNull().references(() => customer.id),
    storeId: uuid('store_id').notNull().references(() => store.id),
    score: integer('score').notNull(),
    tags: ratingTagEnum('tags').array().notNull().default(sql`'{}'`),
    comment: text('comment'),
  },
  (t) => [check('order_rating_score_chk', sql`${t.score} between 1 and 5`), index('order_rating_store_idx').on(t.storeId, t.createdAt)],
);
