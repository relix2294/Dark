import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared/time.js';
import type { HoldResult, OpResult, ProviderStatus, WalletAdapter } from './adapter.js';

/**
 * Заглушка кошелька: в памяти, идемпотентна по ключу, детерминированно отклоняет
 * dcUserId с суффиксом "-declined" и «теряет ответ» для суффикса "-timeout" (для тестов сверки).
 */
export class StubWalletAdapter implements WalletAdapter {
  readonly name = 'stub';
  private readonly ops = new Map<string, HoldResult | OpResult>();
  private readonly state = new Map<string, { status: ProviderStatus; amount: number; captured: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly holdTtlMs = 7 * 24 * 60 * 60 * 1000,
  ) {}

  async hold(input: { dcUserId: string; amount: number; orderNumber: string; idempotencyKey: string }): Promise<HoldResult> {
    const cached = this.ops.get(input.idempotencyKey);
    if (cached) return cached as HoldResult;
    let result: HoldResult;
    if (input.dcUserId.endsWith('-timeout')) {
      result = { ok: false, reason: 'timeout', message: 'нет ответа банка' };
    } else if (input.dcUserId.endsWith('-declined')) {
      result = { ok: false, reason: 'declined', message: 'недостаточно средств' };
    } else {
      const providerRef = `stub_${randomUUID()}`;
      this.state.set(providerRef, { status: 'held', amount: input.amount, captured: 0 });
      result = { ok: true, providerRef, expiresAt: new Date(this.clock.now().getTime() + this.holdTtlMs) };
    }
    this.ops.set(input.idempotencyKey, result);
    return result;
  }

  async capture(input: { providerRef: string; amount: number; idempotencyKey: string }): Promise<OpResult> {
    return this.op(input.idempotencyKey, input.providerRef, (s) => {
      if (s.status !== 'held') return { ok: false, reason: 'rejected', message: `холд в состоянии ${s.status}` };
      if (input.amount > s.amount) return { ok: false, reason: 'rejected', message: 'capture больше холда' };
      s.status = 'captured';
      s.captured = input.amount;
      return { ok: true, providerRef: input.providerRef };
    });
  }

  async release(input: { providerRef: string; idempotencyKey: string }): Promise<OpResult> {
    return this.op(input.idempotencyKey, input.providerRef, (s) => {
      if (s.status !== 'held') return { ok: false, reason: 'rejected', message: `холд в состоянии ${s.status}` };
      s.status = 'released';
      return { ok: true, providerRef: input.providerRef };
    });
  }

  async refund(input: { providerRef: string; amount: number; idempotencyKey: string }): Promise<OpResult> {
    return this.op(input.idempotencyKey, input.providerRef, (s) => {
      if (s.status !== 'captured' && s.status !== 'refunded')
        return { ok: false, reason: 'rejected', message: `платёж в состоянии ${s.status}` };
      if (input.amount > s.captured) return { ok: false, reason: 'rejected', message: 'refund больше списания' };
      s.captured -= input.amount;
      s.status = 'refunded';
      return { ok: true, providerRef: input.providerRef };
    });
  }

  async status(providerRef: string): Promise<ProviderStatus> {
    return this.state.get(providerRef)?.status ?? 'unknown';
  }

  private op(
    key: string,
    ref: string,
    fn: (s: { status: ProviderStatus; amount: number; captured: number }) => OpResult,
  ): OpResult {
    const cached = this.ops.get(key);
    if (cached) return cached as OpResult;
    const s = this.state.get(ref);
    const result: OpResult = s ? fn(s) : { ok: false, reason: 'rejected', message: 'неизвестный provider_ref' };
    this.ops.set(key, result);
    return result;
  }
}
