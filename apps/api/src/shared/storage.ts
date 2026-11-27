import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Хранилище файлов (фото товаров). Два драйвера за одним интерфейсом:
 * - local: каталог на диске (в проде — том Docker, отдаёт Caddy по /media/*);
 * - s3: любое S3-совместимое хранилище (Yandex Object Storage, Selectel, R2, AWS) — переменными окружения.
 * Ключ содержит хэш содержимого: повторная загрузка того же файла даёт тот же адрес, кэш браузера не врёт.
 */
export interface Storage {
  put(prefix: string, bytes: Buffer, ext: string, contentType: string): Promise<{ key: string; url: string }>;
  /** Только для local: прочитать файл для раздачи в разработке. */
  read?(key: string): Promise<Buffer | null>;
}

const keyFor = (prefix: string, bytes: Buffer, ext: string) => `${prefix}/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`;

export function localStorage(dir: string, publicBase: string): Storage {
  const root = resolve(dir);
  return {
    async put(prefix, bytes, ext) {
      const key = keyFor(prefix, bytes, ext);
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { key, url: `${publicBase.replace(/\/$/, '')}/${key}` };
    },
    async read(key) {
      const path = normalize(join(root, key));
      if (!path.startsWith(root + sep)) return null; // ../ за пределы каталога
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    },
  };
}

export function s3Storage(o: { endpoint?: string | undefined; region: string; bucket: string; publicBase: string; accessKeyId: string; secretAccessKey: string }): Storage {
  const client = new S3Client({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
  });
  return {
    async put(prefix, bytes, ext, contentType) {
      const key = keyFor(prefix, bytes, ext);
      await client.send(new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
      return { key, url: `${o.publicBase.replace(/\/$/, '')}/${key}` };
    },
  };
}

/** Тип картинки по первым байтам — расширению и Content-Type клиента не доверяем. */
export function sniffImage(b: Buffer): { ext: 'jpg' | 'png' | 'webp'; type: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
