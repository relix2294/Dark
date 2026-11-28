import { pgEnum } from 'drizzle-orm/pg-core';
import * as C from '@dark/contracts';

// Один источник значений — @dark/contracts. Enum в БД генерируется из него.
export const brandEnum = pgEnum('brand', C.BRAND_VALUES);
export const orderStatusEnum = pgEnum('order_status', C.ORDER_STATUS_VALUES);
export const orderItemStatusEnum = pgEnum('order_item_status', C.ORDER_ITEM_STATUS_VALUES);
export const replacePolicyEnum = pgEnum('replace_policy', C.REPLACE_POLICY_VALUES);
export const ratingTagEnum = pgEnum('rating_tag', C.RATING_TAG_VALUES);
export const deviceAppEnum = pgEnum('device_app', C.DEVICE_APP_VALUES);
export const callRoleEnum = pgEnum('call_role', C.CALL_ROLE_VALUES);
export const payoutKindEnum = pgEnum('payout_kind', C.PAYOUT_KIND_VALUES);
export const payoutStatusEnum = pgEnum('payout_status', C.PAYOUT_STATUS_VALUES);
export const paymentStatusEnum = pgEnum('payment_status', C.PAYMENT_STATUS_VALUES);
export const paymentOpTypeEnum = pgEnum('payment_op_type', C.PAYMENT_OP_TYPE_VALUES);
export const deliveryTaskStatusEnum = pgEnum('delivery_task_status', C.DELIVERY_TASK_STATUS_VALUES);
export const courierStatusEnum = pgEnum('courier_status', C.COURIER_STATUS_VALUES);
export const transportEnum = pgEnum('transport', C.TRANSPORT_VALUES);
export const tempZoneEnum = pgEnum('temp_zone', C.TEMP_ZONE_VALUES);
export const stationEnum = pgEnum('station', C.STATION_VALUES);
export const stockMoveTypeEnum = pgEnum('stock_move_type', C.STOCK_MOVE_TYPE_VALUES);
export const promoTypeEnum = pgEnum('promo_type', C.PROMO_TYPE_VALUES);
export const promoAudienceEnum = pgEnum('promo_audience', C.PROMO_AUDIENCE_VALUES);
export const staffRoleEnum = pgEnum('staff_role', C.STAFF_ROLE_VALUES);
export const actorTypeEnum = pgEnum('actor_type', C.ACTOR_TYPE_VALUES);
