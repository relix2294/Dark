import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { PickLabelView, PickTaskView } from '@dark/contracts';
import { ApiError, Badge, Button, Card, ErrorBanner, NumPad, Spinner, postOrQueue, useBarcodeScanner, useLive, useOfflineQueue, useStaff } from '@dark/ui';

type Task = z.infer<typeof PickTaskView>;
type Item = Task['items'][number];
type Label = z.infer<typeof PickLabelView>;

/**
 * Поток сборки: ячейка → товар → количество (ТЗ §7). Терминал показывает таймер и подсвечивает текущую ячейку.
 * Сканы, сделанные без связи, копятся в очереди и уходят при восстановлении (до 30 минут, ТЗ §7).
 */
export function Picking() {
  const { api } = useStaff();
  const qc = useQueryClient();
  // новое задание: событие order.status_changed → перечитываем; опрос раз в 15 с — страховка
  useLive(api);
  // текущее задание хранится на устройстве: перезагрузка без связи не теряет сборку
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem('dark.picker.task') ?? 'null') as Task | null;
    } catch {
      return null;
    }
  })();
  const task = useQuery({
    queryKey: ['pick-next'],
    queryFn: () => api.get<Task | null>('/wms/pick-tasks/next'),
    refetchInterval: (q) => (q.state.data ? false : 15_000),
    ...(cached ? { initialData: cached, initialDataUpdatedAt: 0 } : {}),
  });
  useEffect(() => {
    if (task.data !== undefined) localStorage.setItem('dark.picker.task', JSON.stringify(task.data));
  }, [task.data]);
  const queue = useOfflineQueue<Task>(api, 'dark.picker.queue', (data) => qc.setQueryData(['pick-next'], data));
  const [cell, setCell] = useState<string | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const [label, setLabel] = useState<Label | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['pick-next'] });
  const t = task.data;

  const scan = useMutation({
    mutationFn: async (p: { cell_code: string; barcode: string; qty: number; weight_g?: number }) => {
      if (queue.overLimit) throw new ApiError(0, 'NETWORK', 'Нет связи больше 30 минут — выйдите на связь, очередь сканов ждёт отправки');
      const r = await postOrQueue<Task>(api, queue, `/wms/pick-tasks/${t!.task_id}/scan`, p, `${p.barcode} ×${p.weight_g ?? p.qty}`);
      if (!r.queued) return r.data;
      // без связи: отмечаем локально, сервер подтвердит при отправке очереди
      return applyLocal(t!, p);
    },
    onSuccess: (data) => {
      qc.setQueryData(['pick-next'], data);
      setItem(null);
      setBarcode(null);
      setQty('1');
      setError(null);
      beep(true);
    },
    onError: (e) => {
      setError(e);
      beep(false);
    },
  });
  const offline = queue.items.length > 0;
  // блюдо кухни (этап 2 ТЗ §8): забрать со станции, когда кухня отметила готовность
  const handoff = useMutation({
    mutationFn: (orderItemId: string) => api.post(`/kds/handoff/${orderItemId}`),
    onSuccess: refresh,
    onError: setError,
  });
  const missing = useMutation({
    mutationFn: (p: { order_item_id: string; decision?: 'auto' | 'remove' }) => api.post<Task>(`/wms/pick-tasks/${t!.task_id}/missing`, p),
    onSuccess: (data) => {
      qc.setQueryData(['pick-next'], data);
      setItem(null);
      setError(null);
    },
    onError: setError,
  });
  const complete = useMutation({
    mutationFn: () => api.post<Label>(`/wms/pick-tasks/${t!.task_id}/complete`),
    onSuccess: (l) => {
      setLabel(l);
      setCell(null);
      localStorage.removeItem('dark.picker.task');
      qc.setQueryData(['pick-next'], null);
    },
    onError: setError,
  });

  const onScan = useCallback(
    (code: string) => {
      if (!t) return;
      setError(null);
      // код ячейки: буква-цифры-цифра, иначе — товар
      if (/^[A-ZА-Я]-\d{2}-\d$/i.test(code)) {
        setCell(code.toUpperCase());
        setItem(null);
        return;
      }
      const hit = t.items.find((i) => i.status === 'pending' && i.barcodes.includes(code));
      if (!hit) {
        setError(new ApiError(409, 'WRONG_PRODUCT', `Товара ${code} нет среди несобранных позиций`));
        beep(false);
        return;
      }
      if (!cell) {
        setError(new ApiError(409, 'WRONG_CELL', 'Сначала отсканируйте ячейку'));
        beep(false);
        return;
      }
      setItem(hit);
      setBarcode(code);
      if (!hit.is_weighted && hit.qty_ordered - hit.qty_picked === 1) {
        scan.mutate({ cell_code: cell, barcode: code, qty: 1 });
      } else setQty(hit.is_weighted ? '' : String(hit.qty_ordered - hit.qty_picked));
    },
    [t, cell, scan],
  );
  useBarcodeScanner(onScan, !!t && !label);

  if (label) {
    return (
      <Card tone="green">
        <h2>Заказ {label.order_number} собран</h2>
        <div className="big">{label.barcode}</div>
        <div className="muted">Ярлык напечатан. Зоны: {label.temp_zones.join(', ')}. Поставьте пакет в зону выдачи.</div>
        <Button big primary onClick={() => { setLabel(null); refresh(); }}>
          Следующее задание
        </Button>
      </Card>
    );
  }
  if (task.isLoading) return <Spinner />;
  if (!t)
    return (
      <div className="empty">
        Заданий нет. Ждём заказ…
        <ErrorBanner error={task.error} />
      </div>
    );

  const elapsed = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
  const late = elapsed * 1000 > t.sla_ms;
  const pending = t.items.filter((i) => i.status === 'pending');

  return (
    <>
      <div className="row">
        <h2>Заказ {t.order_number}</h2>
        <Badge tone={late ? 'red' : 'green'}>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / {t.sla_ms / 60000}:00
        </Badge>
      </div>
      {t.comment && <div className="banner">{t.comment}</div>}
      <ErrorBanner error={error} />
      {offline && (
        <div className="banner banner-error">
          Нет связи: {queue.items.length} скан(ов) в очереди, отправятся автоматически. Завершить сборку можно после отправки.
        </div>
      )}
      {queue.failed.map((f) => (
        <div key={f.key} className="banner banner-error" onClick={queue.clearFailed}>
          Скан {f.label} не принят сервером: {f.error}. Пересоберите позицию.
        </div>
      ))}
      <div className="muted">Ячейка: {cell ? <b style={{ color: 'var(--text)' }}>{cell}</b> : 'отсканируйте ячейку'}</div>
      {t.items
        .filter((i) => i.call_deadline && new Date(i.call_deadline).getTime() > Date.now())
        .map((i) => (
          <Card key={`call-${i.order_item_id}`} tone="red">
            <h2>Позвоните клиенту: {i.name}</h2>
            <div className="big">{Math.max(0, Math.ceil((new Date(i.call_deadline!).getTime() - Date.now()) / 1000))} с</div>
            <div className="muted">Нет ответа за 60 секунд — позиция остаётся убранной, сборка продолжается.</div>
            <div className="row">
              <Button primary disabled={offline} onClick={() => missing.mutate({ order_item_id: i.order_item_id, decision: 'auto' })}>
                Согласен на замену
              </Button>
              <Button danger disabled={offline} onClick={() => missing.mutate({ order_item_id: i.order_item_id, decision: 'remove' })}>
                Убрать
              </Button>
            </div>
          </Card>
        ))}
      {t.items.map((i) => (
        <Card key={i.order_item_id} tone={i.status === 'picked' ? 'done' : i.status === 'missing' ? 'red' : cell && i.cells.some((c) => c.cell_code === cell) ? 'yellow' : undefined} onClick={() => { if (i.status === 'pending' && !i.kitchen) setItem(i); }}>
          <div className="row">
            <b>{i.name}</b>
            <Badge tone={i.status === 'picked' ? 'green' : i.status === 'missing' ? 'red' : 'grey'}>
              {i.is_weighted ? (i.status === 'picked' ? `${i.qty_picked} г` : `~${i.qty_ordered} г`) : `${i.qty_picked}/${i.qty_ordered}`}
            </Badge>
          </div>
          {i.kitchen ? (
            <div className="row">
              <span className="muted">С кухни, станция {i.kitchen.station}: {i.kitchen.ready ? 'готово' : 'готовится'}</span>
              {i.status === 'pending' && (
                <Button primary={i.kitchen.ready} disabled={!i.kitchen.ready || handoff.isPending || offline} onClick={() => handoff.mutate(i.order_item_id)}>
                  Забрал с кухни
                </Button>
              )}
            </div>
          ) : (
            <div className="muted">
              {i.cells.map((c) => `${c.cell_code} ×${c.qty}`).join(', ') || 'ячейка не назначена'} · {i.temp_zone}
            </div>
          )}
        </Card>
      ))}
      {item && item.status === 'pending' && (
        <Card tone="yellow">
          <h2>{item.name}</h2>
          {barcode && cell ? (
            <>
              <div className="muted">{item.is_weighted ? 'Вес, граммы' : 'Количество'}</div>
              <div className="big">{qty || '0'}</div>
              <NumPad
                value={qty}
                onChange={setQty}
                onEnter={() =>
                  item.is_weighted
                    ? scan.mutate({ cell_code: cell, barcode, qty: 1, weight_g: Number(qty) })
                    : scan.mutate({ cell_code: cell, barcode, qty: Number(qty) })
                }
              />
            </>
          ) : (
            <div className="muted">Отсканируйте ячейку и товар, или отметьте «нет на полке»</div>
          )}
          <div className="row">
            <Button danger disabled={offline} onClick={() => missing.mutate({ order_item_id: item.order_item_id })}>
              Нет на полке
            </Button>
            <Button onClick={() => setItem(null)}>Закрыть</Button>
          </div>
        </Card>
      )}
      {pending.length === 0 && (
        <Button big primary disabled={complete.isPending || offline} onClick={() => complete.mutate()}>
          Завершить сборку и напечатать ярлык
        </Button>
      )}
    </>
  );
}

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = ok ? 880 : 220;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    /* без звука */
  }
}

/** Локальное применение скана без связи: та же логика засчитывания, что на сервере. */
function applyLocal(t: Task, p: { barcode: string; qty: number; weight_g?: number }): Task {
  let done = false;
  return {
    ...t,
    items: t.items.map((i) => {
      if (done || i.status !== 'pending' || !i.barcodes.includes(p.barcode)) return i;
      done = true;
      if (i.is_weighted) return { ...i, qty_picked: p.weight_g ?? 0, status: 'picked' };
      const picked = Math.min(i.qty_ordered, i.qty_picked + p.qty);
      return { ...i, qty_picked: picked, status: picked >= i.qty_ordered ? 'picked' : 'pending' };
    }),
  };
}
