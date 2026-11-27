import pino, { type LoggerOptions } from 'pino';

/**
 * Структурированные логи с request_id и order_id (ТЗ §10).
 * В логи не попадают токены, телефоны и данные кошелька — redact.
 */
/** Секреты в строке запроса (WebSocket передаёт JWT в ?token=, браузер не умеет заголовки). */
const SECRET_QUERY = /([?&](?:token|dc_token|pin)=)[^&#]*/gi;
export const scrubUrl = (url: string) => url.replace(SECRET_QUERY, '$1[redacted]');

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    serializers: {
      // стандартный сериализатор Fastify пишет url целиком — вместе с ?token=
      req: (req: { method?: string; url?: string; host?: string; ip?: string; id?: string }) => ({
        method: req.method,
        url: req.url ? scrubUrl(req.url) : req.url,
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
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
