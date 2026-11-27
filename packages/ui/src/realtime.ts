import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Api } from './api.js';

export type LiveEvent = { topic: string; aggregate_type: string; aggregate_id: string; store_id: string | null };

/**
 * Живые обновления экранов персонала: WebSocket /api/v1/ws → на любое событие точки перечитать активные запросы.
 * Сообщение — только сигнал, данные приходят через REST с обычной проверкой прав. Переподключение с паузой до 30 с.
 * Пока сокет открыт, опрос можно делать редким (refetchInterval 30 с — страховка).
 */
export function useLive(api: Api, opts: { storeId?: string | null; onEvent?: (e: LiveEvent) => void } = {}) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      const token = api.token.get();
      if (!token || stop) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ token, ...(opts.storeId ? { store_id: opts.storeId } : {}) });
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws?${qs.toString()}`);
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data)) as LiveEvent;
        if (e.topic === 'hello') return;
        onEvent.current?.(e);
        clearTimeout(debounce);
        debounce = setTimeout(() => void qc.invalidateQueries(), 250);
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (stop || ev.code === 4401 || ev.code === 4403) return;
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => {
      stop = true;
      clearTimeout(timer);
      clearTimeout(debounce);
      ws?.close();
    };
  }, [api, qc, opts.storeId]);

  return connected;
}

/** Точка-индикатор связи для шапки экрана. */
export function liveTitle(connected: boolean) {
  return connected ? '● онлайн' : '○ нет связи с событиями';
}
