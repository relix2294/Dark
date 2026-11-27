import { useEffect, useRef } from 'react';

/**
 * Аппаратный сканер Android-терминала отдаёт штрихкод как быстрый ввод с клавиатуры и Enter (ТЗ §7).
 * Хук собирает символы, пришедшие быстрее 50 мс друг за другом, и отдаёт строку по Enter.
 * Ручной ввод в полях формы не перехватывается.
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const buf = useRef('');
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.dataset['scanner']) return;
      const now = Date.now();
      if (now - last.current > 50) buf.current = '';
      last.current = now;
      if (e.key === 'Enter') {
        if (buf.current.length >= 3) onScan(buf.current);
        buf.current = '';
        e.preventDefault();
      } else if (e.key.length === 1) buf.current += e.key;
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onScan, enabled]);
}
