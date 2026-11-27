import pino, { type LoggerOptions } from 'pino';

/**
 * Структурированные логи с request_id и order_id (ТЗ §10).
 * В логи не попадают токены, телефоны и данные кошелька — redact.
 */
export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.pin',
        '*.dc_token',
        '*.token',
        '*.phone',
        '*.provider_response',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
  };
}

export const createLogger = (level: string, pretty: boolean) => pino(loggerOptions(level, pretty));
