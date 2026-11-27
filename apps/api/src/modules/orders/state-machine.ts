import type { ActorType, OrderStatus } from '@dark/contracts';
import { StateMachine } from '../../shared/state-machine.js';
import { AppError } from '../../shared/errors/index.js';

/**
 * Машина состояний заказа — таблица из ТЗ §3, один в один.
 * Условия перехода (все позиции собраны, скан пакета и т.д.) проверяет сервис; здесь — только допустимость.
 */
export const orderMachine = new StateMachine<OrderStatus, ActorType>('order', [
  { from: 'created', to: 'paid_hold', by: ['system'] },
  { from: 'created', to: 'payment_failed', by: ['system'] },
  { from: 'paid_hold', to: 'picking', by: ['staff'] }, // LAB: сборщик взял задание
  { from: 'paid_hold', to: 'cooking', by: ['staff'] }, // SOR: кухня взяла в работу
  { from: ['picking', 'cooking'], to: 'ready', by: ['staff'] },
  { from: 'ready', to: 'on_the_way', by: ['staff'] }, // курьер отсканировал пакет
  { from: 'on_the_way', to: 'delivered', by: ['staff'] },
  { from: 'on_the_way', to: 'returning', by: ['staff'] },
  { from: 'returning', to: 'returned', by: ['staff'] }, // старший смены
  { from: ['paid_hold', 'picking', 'cooking', 'ready'], to: 'cancelled', by: ['customer', 'staff', 'system'] },
]);

/** Клиент может отменить сам только до picking / cooking (ТЗ §3). */
export const CUSTOMER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set(['created', 'paid_hold']);

export const ACTIVE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'paid_hold',
  'picking',
  'cooking',
  'ready',
  'on_the_way',
  'returning',
]);

export function assertCustomerCanCancel(status: OrderStatus): void {
  if (CUSTOMER_CANCELLABLE.has(status)) return;
  // терминальные и «в пути» — INVALID_TRANSITION; picking/cooking/ready — только оператор с причиной
  orderMachine.assert(status, 'cancelled', 'customer');
  throw new AppError('FORBIDDEN', 'Отмена после начала сборки — только оператор с причиной', { status });
}
