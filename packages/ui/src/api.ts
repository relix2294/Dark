import type { ErrorCode } from '@dark/contracts';

/** Ошибка API в формате ТЗ §4. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type Api = ReturnType<typeof createApi>;

/**
 * HTTP-клиент: Bearer-токен из хранилища, Idempotency-Key на каждый изменяющий запрос (UUID на действие),
 * ошибки → ApiError. Один экземпляр на приложение.
 */
export function createApi(opts: { base?: string; tokenKey: string; onUnauthorized?: () => void }) {
  const base = opts.base ?? '/api/v1';
  const token = {
    get: () => localStorage.getItem(opts.tokenKey),
    set: (t: string | null) => (t ? localStorage.setItem(opts.tokenKey, t) : localStorage.removeItem(opts.tokenKey)),
  };

  async function request<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t = token.get();
    if (t) headers['authorization'] = `Bearer ${t}`;
    if (method !== 'GET') headers['idempotency-key'] = idemKey ?? crypto.randomUUID();
    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(base + path, init);
    } catch (e) {
      throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (data as { error?: { code: ErrorCode; message: string; details?: Record<string, unknown> } } | null)?.error;
      if (res.status === 401) opts.onUnauthorized?.();
      throw new ApiError(res.status, err?.code ?? 'INTERNAL', err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return data as T;
  }

  return {
    token,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown, idemKey?: string) => request<T>('POST', path, body ?? {}, idemKey),
    put: <T>(path: string, body: unknown, idemKey?: string) => request<T>('PUT', path, body, idemKey),
    /** SSE-поток заказа; возвращает функцию остановки. */
    stream: (path: string, onEvent: (name: string, data: unknown) => void) => {
      // EventSource не умеет заголовки: передаём токен запросом с fetch + ReadableStream
      const ctrl = new AbortController();
      void (async () => {
        try {
          const res = await fetch(base + path, { headers: { authorization: `Bearer ${token.get() ?? ''}` }, signal: ctrl.signal });
          const reader = res.body?.getReader();
          if (!reader) return;
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const ev = /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message';
              const dataLine = /^data: (.+)$/m.exec(chunk)?.[1];
              if (dataLine) onEvent(ev, JSON.parse(dataLine));
            }
          }
        } catch {
          /* остановлено */
        }
      })();
      return () => ctrl.abort();
    },
  };
}
