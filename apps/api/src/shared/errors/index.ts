import type { ErrorCode } from '@dark/contracts';

const STATUS: Record<ErrorCode, number> = {
  PRICE_CHANGED: 409,
  OUT_OF_STOCK: 409,
  STORE_CLOSED: 409,
  OUT_OF_ZONE: 422,
  MIN_ORDER: 422,
  PAYMENT_DECLINED: 402,
  PAYMENT_TIMEOUT: 504,
  INVALID_TRANSITION: 409,
  WRONG_CELL: 409,
  WRONG_PRODUCT: 409,
  PROMO_NOT_APPLICABLE: 422,
  TOO_FAR_FROM_ADDRESS: 409,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL: 500,
};

/** Единственный тип доменной ошибки. Сериализуется в {"error": {code, message, details}} (ТЗ §4). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError('NOT_FOUND', `${what} не найден`, id ? { id } : undefined);
export const forbidden = (message = 'Недостаточно прав') => new AppError('FORBIDDEN', message);
