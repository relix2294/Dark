import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PAYMENT_PROVIDER: z.enum(['stub', 'dc']).default('stub'),
  DISPLAY_TZ: z.string().default('Asia/Dushanbe'),
  /** Хранилище фото: local — диск (том Docker, отдаёт Caddy), s3 — S3-совместимое. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  /** Публичный адрес файлов: для local — путь, который отдаёт Caddy; для s3 — адрес бакета или CDN. */
  MEDIA_PUBLIC_URL: z.string().default('/media'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Токен для /metrics; пусто — эндпоинт открыт (закрыть на уровне сети). */
  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректные переменные окружения: ${issues}`);
  }
  return parsed.data;
}
