import type { Dirams } from '../../shared/money.js';

/**
 * Интерфейс адаптера кошелька DC (ТЗ §5). Контракт банка не получен — модуль пишется за интерфейсом,
 * до получения API работает StubWalletAdapter с теми же методами.
 */
export type HoldResult =
  | { ok: true; providerRef: string; expiresAt: Date }
  | { ok: false; reason: 'declined' | 'insufficient_funds' | 'timeout' | 'error'; message: string };

export type OpResult = { ok: true; providerRef: string } | { ok: false; reason: 'timeout' | 'error' | 'rejected'; message: string };

export type ProviderStatus = 'unknown' | 'held' | 'captured' | 'released' | 'refunded' | 'failed';

export interface WalletAdapter {
  readonly name: string;
  hold(input: { dcUserId: string; amount: Dirams; orderNumber: string; idempotencyKey: string }): Promise<HoldResult>;
  capture(input: { providerRef: string; amount: Dirams; idempotencyKey: string }): Promise<OpResult>;
  release(input: { providerRef: string; idempotencyKey: string }): Promise<OpResult>;
  refund(input: { providerRef: string; amount: Dirams; idempotencyKey: string }): Promise<OpResult>;
  status(providerRef: string): Promise<ProviderStatus>;
}

/** Параметры, которые нужно получить от банка (ТЗ §5) — фиксируем как конфиг адаптера. */
export interface WalletCapabilities {
  partialCapture: boolean;
  holdTtlMs: number;
  providerIdempotency: boolean;
  webhooks: boolean;
}
