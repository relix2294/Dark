import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api } from './api.js';

/**
 * Очередь действий без связи (ТЗ §7: терминал принимает сканы локально до 30 минут).
 * Каждое действие хранит свой Idempotency-Key: повтор после обрыва не создаёт второго движения на сервере.
 * Порядок сохраняется: очередь отправляется строго по одному. Ошибка 4xx — действие снимается и показывается
 * (например, ячейка оказалась неверной); сетевая ошибка — остановка до следующей попытки.
 */
export type QueuedAction = { key: string; path: string; body: unknown; at: number; label: string };
export type FailedAction = QueuedAction & { error: string };

export const OFFLINE_LIMIT_MS = 30 * 60_000;

/**
 * Обрыв связи, а не ответ сервера: нет сети или шлюз (502–504) без кода ошибки API.
 * Ответ API с кодом (например, 503 CALL_UNAVAILABLE) — это решение сервера, в очередь его не кладём.
 */
export const isConnectivityError = (e: unknown) =>
  e instanceof ApiError && (e.code === 'NETWORK' || e.status === 0 || (e.status >= 502 && e.code === 'INTERNAL'));

const load = (k: string): QueuedAction[] => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '[]') as QueuedAction[];
  } catch {
    return [];
  }
};

export function useOfflineQueue<T>(api: Api, storageKey: string, onResult: (data: T) => void) {
  const [items, setItems] = useState<QueuedAction[]>(() => load(storageKey));
  const [failed, setFailed] = useState<FailedAction[]>([]);
  const busy = useRef(false);
  const ref = useRef(items);
  ref.current = items;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const save = (next: QueuedAction[]) => {
    ref.current = next;
    setItems(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const flush = useCallback(async () => {
    if (busy.current || ref.current.length === 0) return;
    busy.current = true;
    try {
      while (ref.current.length) {
        const a = ref.current[0]!;
        try {
          const data = await api.post<T>(a.path, a.body, a.key);
          save(ref.current.slice(1));
          onResultRef.current(data);
        } catch (e) {
          if (e instanceof ApiError && !isConnectivityError(e)) {
            save(ref.current.slice(1));
            setFailed((f) => [...f, { ...a, error: e.message }]);
          } else break; // нет связи — ждём
        }
      }
    } finally {
      busy.current = false;
    }
  }, [api]);

  useEffect(() => {
    const t = setInterval(() => void flush(), 5000);
    const on = () => void flush();
    window.addEventListener('online', on);
    void flush();
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
    };
  }, [flush]);

  const enqueue = useCallback((a: QueuedAction) => save([...ref.current, a]), []);
  const oldest = items[0]?.at ?? null;
  return {
    items,
    failed,
    clearFailed: () => setFailed([]),
    enqueue,
    flush,
    /** Без связи дольше 30 минут — новые сканы не принимаются, нужен выход на связь. */
    overLimit: oldest !== null && Date.now() - oldest > OFFLINE_LIMIT_MS,
  };
}

/** Действие с ключом: при сетевой ошибке уходит в очередь, при прочих ошибках — пробрасывается. */
export async function postOrQueue<T>(
  api: Api,
  q: { enqueue: (a: QueuedAction) => void },
  path: string,
  body: unknown,
  label: string,
): Promise<{ queued: true } | { queued: false; data: T }> {
  const key = crypto.randomUUID();
  try {
    return { queued: false, data: await api.post<T>(path, body, key) };
  } catch (e) {
    if (isConnectivityError(e)) {
      q.enqueue({ key, path, body, at: Date.now(), label });
      return { queued: true };
    }
    throw e;
  }
}
