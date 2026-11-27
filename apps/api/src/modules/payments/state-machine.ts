import type { PaymentStatus } from '@dark/contracts';
import { StateMachine } from '../../shared/state-machine.js';

/** new → hold_pending → held → capture_pending → captured; ответвления по ТЗ §3. */
export const paymentMachine = new StateMachine<PaymentStatus, 'system'>('payment', [
  { from: 'new', to: 'hold_pending', by: ['system'] },
  { from: 'hold_pending', to: 'held', by: ['system'] },
  { from: 'hold_pending', to: 'failed', by: ['system'] },
  { from: 'held', to: 'released', by: ['system'] },
  { from: 'held', to: 'capture_pending', by: ['system'] },
  { from: 'capture_pending', to: 'captured', by: ['system'] },
  { from: 'capture_pending', to: 'held', by: ['system'] }, // capture не прошёл, остаёмся на холде, повтор по расписанию
  { from: 'captured', to: 'refund_pending', by: ['system'] },
  { from: 'refund_pending', to: 'refunded', by: ['system'] },
  { from: 'refund_pending', to: 'partially_refunded', by: ['system'] },
  { from: 'partially_refunded', to: 'refund_pending', by: ['system'] },
]);

/** Любое *_pending старше этого срока попадает в задачу сверки (ТЗ §3). */
export const PENDING_STALE_MS = 60_000;

export const isPending = (s: PaymentStatus) => s.endsWith('_pending');
