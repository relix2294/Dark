/**
 * Платежи: адаптер кошелька DC, машина состояний, capture/release/refund, сверка (ТЗ §5).
 * Другие модули импортируют только из этого index.ts.
 */
export type { WalletAdapter, HoldResult, OpResult } from './adapter.js';
export { StubWalletAdapter } from './stub-adapter.js';
export { paymentMachine } from './state-machine.js';
export { shiftPay, createShiftPayout, createBonus, sendPendingPayouts, retryPayout, listPayouts, courierPayouts, payoutStatusByShift, type PayRates, type ShiftStats } from './payouts.js';
export { openHold, applyHoldResult, prepareCapture, executeCapture, releaseHold, captureAmountNow, refund, reconcilePending, releaseOrphanHolds, warnExpiringHolds, nightlyReconcile, CAPTURE_RETRY_DELAYS_SEC } from './service.js';
