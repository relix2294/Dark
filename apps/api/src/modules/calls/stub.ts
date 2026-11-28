import { createHash } from 'node:crypto';
import type { BindResult, CallProxy } from './adapter.js';

/**
 * Заглушка провайдера: детерминированный подменный номер из «пула» +992 00 0xx xx xx на связку.
 * Номер клиента с суффиксом 0000 — отказ провайдера (для тестов).
 */
export class StubCallProxy implements CallProxy {
  readonly name = 'stub';
  readonly active = new Map<string, { courierPhone: string; customerPhone: string }>();

  async bind(input: { courierPhone: string; customerPhone: string; ttlSec: number; reference: string }): Promise<BindResult> {
    if (input.customerPhone.endsWith('0000')) return { ok: false, message: 'провайдер не выдал номер' };
    const digits = parseInt(createHash('sha256').update(input.reference).digest('hex').slice(0, 8), 16) % 1_000_000;
    const proxy = `+99200${String(digits).padStart(7, '0')}`;
    const providerRef = `stub_${input.reference}`;
    this.active.set(providerRef, { courierPhone: input.courierPhone, customerPhone: input.customerPhone });
    return { ok: true, providerRef, numberForCourier: proxy, numberForCustomer: proxy };
  }

  async unbind(providerRef: string): Promise<void> {
    this.active.delete(providerRef);
  }
}
