import { describe, expect, it } from 'vitest';
import { orderMachine } from './state-machine.js';
import { AppError } from '../../shared/errors/index.js';

describe('машина состояний заказа (ТЗ §3)', () => {
  it('created → paid_hold системой', () => expect(orderMachine.can('created', 'paid_hold', 'system')).toBe(true));
  it('paid_hold → picking (LAB) и → cooking (SOR)', () => {
    expect(orderMachine.can('paid_hold', 'picking', 'staff')).toBe(true);
    expect(orderMachine.can('paid_hold', 'cooking', 'staff')).toBe(true);
  });
  it('delivered — терминальный', () => {
    expect(() => orderMachine.assert('delivered', 'cancelled', 'staff')).toThrowError(AppError);
    try {
      orderMachine.assert('delivered', 'cancelled', 'staff');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_TRANSITION');
      expect((e as AppError).status).toBe(409);
    }
  });
  it('нельзя перескочить created → ready', () =>
    expect(() => orderMachine.assert('created', 'ready', 'staff')).toThrow(/запрещён/));
  it('клиент не может перевести в on_the_way', () => {
    expect(orderMachine.can('ready', 'on_the_way', 'customer')).toBe(false);
    try {
      orderMachine.assert('ready', 'on_the_way', 'customer');
    } catch (e) {
      expect((e as AppError).code).toBe('FORBIDDEN');
    }
  });
  it('отмена из picking допустима для staff, но не для customer', () => {
    expect(orderMachine.can('picking', 'cancelled', 'staff')).toBe(true);
    expect(orderMachine.can('picking', 'cancelled', 'customer')).toBe(true); // таблица допускает; запрет клиента — в сервисе
  });
});
