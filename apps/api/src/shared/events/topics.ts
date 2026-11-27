/** Обязательный набор событий (ТЗ §10). Новое событие — только добавлением сюда. */
export const TOPICS = [
  'order.created',
  'order.status_changed',
  'order.item_replaced',
  'payment.held',
  'payment.captured',
  'payment.failed',
  'payment.refunded',
  'payment.hold_expiring',
  'payment.reconcile_mismatch',
  'stock.low',
  'stock.out',
  'task.offered',
  'task.accepted',
  'task.expired',
  'courier.status_changed',
  'kds.item_late',
  'dispatch.no_courier',
] as const;
export type Topic = (typeof TOPICS)[number];
