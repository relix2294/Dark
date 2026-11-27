import { z } from 'zod';

/** Обязательные коды ошибок (ТЗ §4). */
export const ErrorCode = z.enum([
  'PRICE_CHANGED',
  'OUT_OF_STOCK',
  'STORE_CLOSED',
  'OUT_OF_ZONE',
  'MIN_ORDER',
  'PAYMENT_DECLINED',
  'PAYMENT_TIMEOUT',
  'INVALID_TRANSITION',
  'WRONG_CELL',
  'WRONG_PRODUCT',
  'PROMO_NOT_APPLICABLE',
  'TOO_FAR_FROM_ADDRESS',
  'FORBIDDEN',
  // технические
  'UNAUTHORIZED',
  'NOT_FOUND',
  'VALIDATION',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Формат ошибки: {"error": {"code", "message", "details"}} */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
