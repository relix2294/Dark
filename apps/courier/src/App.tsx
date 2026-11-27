import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { CourierSelfView, DeliveryTaskView, ShiftSummaryView } from '@dark/contracts';
import { BRAND_RU, Badge, Button, COURIER_STATUS_RU, Card, ErrorBanner, Field, ORDER_STATUS_RU, Screen, Spinner, minutesLeft, time, useBarcodeScanner, useLive, useStaff } from '@dark/ui';

type Me = z.infer<typeof CourierSelfView>;
type Task = z.infer<typeof DeliveryTaskView>;

/**
 * Приложение курьера (ТЗ §9), этап 1 как PWA: смена, задание, скан пакетов, доставка и «клиент не вышел».
 * Позиция отправляется пакетами раз в 5 с пока приложение открыто; события без связи копятся и уходят
 * при восстановлении с метками времени (ТЗ §11). Фоновая геопозиция — нативная обёртка Expo (ADR-006).
 */
export function App() {
  const { api, logout } = useStaff();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/courier/me') });
  const task = useQuery({ queryKey: ['task'], queryFn: () => api.get<Task | null>('/courier/tasks/current') });
  const refresh = () => void qc.invalidateQueries();
  // новое задание приходит событием task.offered — вибрация, чтобы курьер заметил
  useLive(api, { onEvent: (e) => { if (e.topic === 'task.offered') navigator.vibrate?.([200, 100, 200]); } });
  const shift = useMutation({ mutationFn: (p: 'start' | 'end' | 'break') => api.post<Me>(`/courier/shift/${p}`, p === 'start' ? { transport: 'bike' } : {}), onSuccess: refresh });
  const [geo, setGeo] = useState<GeolocationPosition | null>(null);
  const queue = useRef<{ lat: number; lon: number; at: string; accuracy_m: number }[]>(JSON.parse(localStorage.getItem('dark.courier.posq') ?? '[]'));

  // геопозиция: копим точки и отправляем пакетом раз в 5 с; при обрыве — очередь в localStorage
  useEffect(() => {
    if (!me.data || me.data.status === 'offline' || !navigator.geolocation) return;
    const w = navigator.geolocation.watchPosition(
      (p) => {
        setGeo(p);
        // внутри нативного приложения точки шлёт оно само, в том числе в фоне — здесь только для кнопки «Доставлено»
        if (!(window as { DARK_NATIVE?: boolean }).DARK_NATIVE)
          queue.current.push({ lat: p.coords.latitude, lon: p.coords.longitude, at: new Date(p.timestamp).toISOString(), accuracy_m: p.coords.accuracy });
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
    const t = setInterval(async () => {
      if (queue.current.length === 0) return;
      const batch = queue.current.splice(0, 500);
      try {
        await api.post('/courier/position', { points: batch });
        localStorage.removeItem('dark.courier.posq');
      } catch {
        queue.current.unshift(...batch);
        localStorage.setItem('dark.courier.posq', JSON.stringify(queue.current.slice(-2000)));
      }
    }, 5000);
    return () => {
      navigator.geolocation.clearWatch(w);
      clearInterval(t);
    };
  }, [me.data?.status, api, me.data]);

  if (me.isLoading) return <Spinner />;
  const m = me.data;
  return (
    <Screen
      title={m ? <span>{COURIER_STATUS_RU[m.status]} <Badge tone={m.status === 'free' ? 'green' : 'grey'}>доставок: {m.deliveries_today}</Badge></span> : 'Курьер'}
      actions={<Button onClick={logout}>Выйти</Button>}
    >
      <ErrorBanner error={me.error ?? shift.error} />
      {m?.status === 'offline' ? (
        <>
          <Button big primary disabled={shift.isPending} onClick={() => shift.mutate('start')}>
            Начать смену
          </Button>
          <ShiftSummary />
        </>
      ) : (
        <>
          {task.data ? <TaskCard task={task.data} geo={geo} onChange={refresh} /> : <div className="empty">Заданий нет. Ждём назначения…</div>}
          <div className="row">
            <Button disabled={shift.isPending || !!task.data} onClick={() => shift.mutate('break')}>
              {m?.status === 'break' ? 'Вернуться с перерыва' : 'Перерыв'}
            </Button>
            <Button danger disabled={shift.isPending || !!task.data} onClick={() => shift.mutate('end')}>
              Закончить смену
            </Button>
          </div>
          {!task.data && <ShiftSummary />}
          <div className="muted">
            GPS: {geo ? `${geo.coords.latitude.toFixed(5)}, ${geo.coords.longitude.toFixed(5)} ±${Math.round(geo.coords.accuracy)} м` : 'нет данных'} · очередь точек: {queue.current.length}
          </div>
        </>
      )}
    </Screen>
  );
}

function TaskCard({ task, geo, onChange }: { task: Task; geo: GeolocationPosition | null; onChange: () => void }) {
  const { api } = useStaff();
  const [scanned, setScanned] = useState<string[]>([]);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<unknown>(null);
  const expected = task.orders.map((o) => o.package_barcode);
  const allScanned = expected.every((b) => scanned.includes(b));

  const accept = useMutation({ mutationFn: () => api.post<Task>(`/courier/tasks/${task.task_id}/accept`), onSuccess: onChange, onError: setError });
  const pickup = useMutation({ mutationFn: () => api.post<Task>(`/courier/tasks/${task.task_id}/pickup`, { package_barcodes: scanned }), onSuccess: () => { setScanned([]); onChange(); }, onError: setError });
  const delivered = useMutation({
    mutationFn: (orderId: string) => api.post(`/courier/orders/${orderId}/delivered`, { geo: { lat: geo?.coords.latitude ?? 0, lon: geo?.coords.longitude ?? 0 } }),
    onSuccess: onChange,
    onError: setError,
  });
  const noShow = useMutation({ mutationFn: (orderId: string) => api.post<Task>(`/courier/orders/${orderId}/no-show`, { calls: 2 }), onSuccess: onChange, onError: setError });

  useBarcodeScanner(
    useCallback((code: string) => setScanned((s) => (s.includes(code) ? s : [...s, code])), []),
    task.status !== 'delivering',
  );

  const navTo = (o: Task['orders'][number]) => `https://www.openstreetmap.org/directions?from=&to=${o.address.geo.lat}%2C${o.address.geo.lon}`;

  return (
    <>
      <ErrorBanner error={error} />
      <Card tone={task.status === 'offered' ? 'yellow' : undefined}>
        <div className="row">
          <h2>Задание · {task.status}</h2>
          {task.offer_expires_at && <Badge tone="yellow">принять до {time(task.offer_expires_at)}</Badge>}
        </div>
        <div className="muted">Забрать: {task.store.name}, {task.store.address}</div>
        {task.status === 'offered' && (
          <Button big primary disabled={accept.isPending} onClick={() => accept.mutate()}>
            Принять
          </Button>
        )}
      </Card>
      {task.orders.map((o) => (
        <Card key={o.order_id} tone={o.status === 'on_the_way' ? 'green' : undefined}>
          <div className="row">
            <b>
              {BRAND_RU[o.brand]} · {o.number}
            </b>
            <Badge tone={o.status === 'ready' ? 'green' : 'blue'}>{ORDER_STATUS_RU[o.status]}</Badge>
          </div>
          <div>
            {o.address.street}, {o.address.house}
            {o.address.entrance ? `, подъезд ${o.address.entrance}` : ''}
            {o.address.floor ? `, этаж ${o.address.floor}` : ''}
            {o.address.flat ? `, кв. ${o.address.flat}` : ''}
          </div>
          {o.address.comment && <div className="muted">{o.address.comment}</div>}
          <div className="muted">
            Обещано к {time(o.promised_at)} ({minutesLeft(o.promised_at)}) · пакет {o.package_barcode} · {o.temp_zones.join(', ')}
          </div>
          {task.status !== 'delivering' && scanned.includes(o.package_barcode) && <Badge tone="green">пакет отсканирован</Badge>}
          {o.status === 'on_the_way' && (
            <>
              <a className="btn" href={navTo(o)} target="_blank" rel="noreferrer">
                Маршрут ↗
              </a>
              <Button big primary disabled={delivered.isPending || !geo} onClick={() => delivered.mutate(o.order_id)}>
                Доставлено
              </Button>
              <Button danger disabled={noShow.isPending} onClick={() => confirm('2 звонка сделаны, клиент не вышел?') && noShow.mutate(o.order_id)}>
                Клиент не вышел
              </Button>
            </>
          )}
        </Card>
      ))}
      {task.status !== 'delivering' && (
        <Card>
          <h2>Скан ярлыков пакетов</h2>
          <div className="muted">
            {scanned.length}/{expected.length} отсканировано
          </div>
          <Field label="Или введите код вручную">
            <div className="row">
              <input className="input" value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} data-scanner="1" />
              <Button onClick={() => { if (manual) setScanned((s) => (s.includes(manual) ? s : [...s, manual])); setManual(''); }}>+</Button>
            </div>
          </Field>
          <Button big primary disabled={!allScanned || pickup.isPending} onClick={() => pickup.mutate()}>
            Забрал пакеты — в путь
          </Button>
        </Card>
      )}
    </>
  );
}

const hm = (min: number) => `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин`;

/** Итоги смены (ТЗ §9 «заработок за смену»): сумма в деньгах появится, когда утвердят модель оплаты курьеров. */
function ShiftSummary() {
  const { api } = useStaff();
  const q = useQuery({ queryKey: ['shift-summary'], queryFn: () => api.get<z.infer<typeof ShiftSummaryView> | null>('/courier/shift/summary'), refetchInterval: 60_000 });
  const s = q.data;
  if (!s) return null;
  return (
    <Card>
      <div className="row">
        <b>{s.shift_ended_at ? 'Итоги прошлой смены' : 'Смена сейчас'}</b>
        <span className="muted">
          {time(s.shift_started_at)}–{s.shift_ended_at ? time(s.shift_ended_at) : 'сейчас'}
        </span>
      </div>
      <div className="stats">
        <div>
          <div className="big">{s.delivered}</div>
          <div className="muted">доставок</div>
        </div>
        <div>
          <div className="big">{s.km.toFixed(1)}</div>
          <div className="muted">км</div>
        </div>
        <div>
          <div className="big">{hm(s.minutes)}</div>
          <div className="muted">на смене</div>
        </div>
      </div>
      <div className="muted">
        поездок {s.trips} · вовремя {s.on_time} из {s.delivered}
        {s.returned > 0 && ` · возвратов ${s.returned}`}
        {s.avg_delivery_min != null && ` · в среднем ${s.avg_delivery_min} мин от точки до клиента`}
      </div>
    </Card>
  );
}
