import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { KdsItemView, KdsPackListView, KdsQueueView, StopListView, Station } from '@dark/contracts';
import { Badge, Button, Card, ErrorBanner, Screen, Spinner, liveTitle, minutesLeft, plural, postOrQueue, time, useLive, useOfflineQueue, useStaff } from '@dark/ui';

type Queue = z.infer<typeof KdsQueueView>;
type Item = z.infer<typeof KdsItemView>;
type Pack = z.infer<typeof KdsPackListView>;
type Stop = z.infer<typeof StopListView>;
type Tab = Station | 'stop';

const STATION_RU: Record<Station, string> = { pizza: 'Пицца', grill: 'Гриль', cold: 'Холодный цех', pack: 'Упаковка' };

/** Экран кухни (ТЗ §8): очередь станции с цветами, упаковка, стоп-лист. Планшет в ландшафте, крупные карточки. */
export function App() {
  const { api, logout } = useStaff();
  const live = useLive(api);
  const [tab, setTab] = useState<Tab>((localStorage.getItem('dark.kds.tab') as Tab) ?? 'pizza');
  const pick = (t: Tab) => {
    setTab(t);
    localStorage.setItem('dark.kds.tab', t);
  };
  return (
    <Screen
      title={
        <div className="tabs">
          {(['pizza', 'grill', 'cold', 'pack', 'stop'] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' tab-active' : ''}`} onClick={() => pick(t)}>
              {t === 'stop' ? 'Стоп-лист' : STATION_RU[t]}
            </button>
          ))}
        </div>
      }
      actions={
        <>
          <Badge tone={live ? 'green' : 'red'}>{liveTitle(live)}</Badge>
          <Button onClick={logout}>Выйти</Button>
        </>
      }
    >
      {tab === 'stop' ? <StopList /> : tab === 'pack' ? <PackScreen /> : <StationQueue station={tab} />}
    </Screen>
  );
}

/** Последняя очередь станции с сервера: без связи и после перезагрузки повар видит свои блюда (ТЗ §11). */
const cacheKey = (station: Station) => `dark.kds.queue.${station}`;
function cachedQueue(station: Station): Queue | undefined {
  try {
    const v = localStorage.getItem(cacheKey(station));
    return v ? (JSON.parse(v) as Queue) : undefined;
  } catch {
    return undefined;
  }
}

function StationQueue({ station }: { station: Station }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['kds', station],
    queryFn: async () => {
      const data = await api.get<Queue>(`/kds/queue?station=${station}`);
      try {
        localStorage.setItem(cacheKey(station), JSON.stringify(data));
      } catch {
        /* без копии */
      }
      return data;
    },
    initialData: () => cachedQueue(station),
    initialDataUpdatedAt: 0,
  });
  // нажатия без связи копятся с временем нажатия и уходят по порядку (ТЗ §11)
  const queue = useOfflineQueue<Item>(api, 'dark.kds.actions', () => void qc.invalidateQueries({ queryKey: ['kds'] }));
  const act = useMutation({
    mutationFn: (p: { id: string; name: string; action: 'start' | 'done' }) =>
      postOrQueue<Item>(api, queue, `/kds/items/${p.id}/${p.action}`, { at: new Date().toISOString() }, `${p.action === 'start' ? 'начать' : 'готово'}: ${p.name}`),
    onSuccess: (r) => {
      if (!r.queued) void qc.invalidateQueries({ queryKey: ['kds', station] });
    },
  });
  if (q.isLoading && !q.data) return <Spinner />;
  // нажатое, но не дошедшее до сервера, показываем сделанным
  const queued = new Set(queue.items.map((a) => a.path));
  const now = new Date().toISOString();
  const items = (q.data?.items ?? []).map((i) =>
    queued.has(`/kds/items/${i.id}/done`)
      ? { ...i, started_at: i.started_at ?? now, done_at: now, color: 'done' as const }
      : queued.has(`/kds/items/${i.id}/start`)
        ? { ...i, started_at: now }
        : i,
  );
  const inWork = items.filter((i) => i.started_at && !i.done_at).length;
  return (
    <>
      <ErrorBanner error={queue.items.length || q.data ? act.error : (q.error ?? act.error)} />
      {queue.items.length > 0 && <div className="banner">Нет связи — {queue.items.length} {plural(queue.items.length, 'нажатие ждёт', 'нажатия ждут', 'нажатий ждут')} отправки. Работайте дальше, отправим сами.</div>}
      {q.error != null && queue.items.length === 0 && q.data && <div className="banner">Нет связи с сервером — показана последняя очередь. Новые заказы появятся, когда связь вернётся.</div>}
      {queue.failed.map((f) => (
        <div key={f.key} className="banner banner-error" onClick={queue.clearFailed}>
          «{f.label}» не принято сервером: {f.error}
        </div>
      ))}
      <div className="muted">
        В работе: {inWork} · в очереди: {items.filter((i) => !i.started_at).length}
      </div>
      {items.length === 0 && <div className="empty">Очередь пуста</div>}
      <div className="grid">
        {items.map((i) => (
          <Card key={i.id} tone={i.color}>
            <div className="row">
              <h2>{i.name}</h2>
              <Badge tone={i.color === 'red' ? 'red' : i.color === 'yellow' ? 'yellow' : i.color === 'done' ? 'green' : 'grey'}>×{i.qty}</Badge>
            </div>
            {i.order_number.startsWith('L-') && <Badge tone="blue">Lablabu — заберёт сборщик</Badge>}
            <div className="muted">
              Заказ {i.order_number} · старт {time(i.start_at)} · готовность {time(i.target_ready_at)} ({minutesLeft(i.target_ready_at)})
            </div>
            {i.modifiers && i.modifiers.length > 0 && (
              <div className="big" style={{ fontSize: 18 }}>
                {i.modifiers.map((g) => `${g.group}: ${g.options.map((o) => o.name).join(', ')}`).join(' · ')}
              </div>
            )}
            {!i.started_at && (
              <Button big primary={i.color !== 'grey'} disabled={act.isPending} onClick={() => act.mutate({ id: i.id, name: i.name, action: 'start' })}>
                {i.color === 'grey' ? 'Начать раньше' : 'Начать'}
              </Button>
            )}
            {i.started_at && !i.done_at && (
              <Button big primary disabled={act.isPending} onClick={() => act.mutate({ id: i.id, name: i.name, action: 'done' })}>
                Готово
              </Button>
            )}
            {i.done_at && <div className="muted">Готово {time(i.done_at)} — ждёт упаковки</div>}
          </Card>
        ))}
      </div>
    </>
  );
}

function PackScreen() {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['kds', 'pack'], queryFn: () => api.get<Pack>('/kds/pack') });
  const packed = useMutation({
    mutationFn: (orderId: string) => api.post<{ order_number: string; barcode: string }>(`/kds/orders/${orderId}/packed`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds'] }),
  });
  if (q.isLoading) return <Spinner />;
  return (
    <>
      <ErrorBanner error={q.error ?? packed.error} />
      {packed.data && <div className="banner banner-ok">Заказ {packed.data.order_number} упакован, ярлык {packed.data.barcode}</div>}
      {(q.data?.orders ?? []).length === 0 && <div className="empty">Нет заказов в готовке</div>}
      <div className="grid">
        {(q.data?.orders ?? []).map((o) => (
          <Card key={o.order_id} tone={o.all_done ? 'green' : undefined}>
            <div className="row">
              <h2>{o.order_number}</h2>
              <span className="muted">готовность {time(o.target_ready_at)}</span>
            </div>
            {o.items.map((i) => (
              <div key={i.id} className="row">
                <span>
                  {i.name} ×{i.qty}
                  {i.modifiers && i.modifiers.length > 0 && <span className="muted"> · {i.modifiers.map((g) => g.options.map((o) => o.name).join(', ')).join('; ')}</span>}
                </span>
                <Badge tone={i.done_at ? 'green' : i.color === 'red' ? 'red' : 'yellow'}>{i.done_at ? 'готово' : i.started_at ? 'в работе' : 'ждёт'}</Badge>
              </div>
            ))}
            <Button big primary disabled={!o.all_done || packed.isPending} onClick={() => packed.mutate(o.order_id)}>
              Упаковано — печать ярлыка
            </Button>
          </Card>
        ))}
      </div>
    </>
  );
}

function StopList() {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stop-list'], queryFn: () => api.get<Stop>('/kds/stop-list'), refetchInterval: false });
  const [pid, setPid] = useState('');
  const save = useMutation({
    mutationFn: (body: Stop) => api.put<Stop>('/kds/stop-list', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stop-list'] }),
  });
  const cur = q.data ?? { product_ids: [], ingredient_ids: [] };
  return (
    <>
      <ErrorBanner error={q.error ?? save.error} />
      <Card>
        <h2>Недоступные блюда</h2>
        {cur.product_ids.length === 0 && <div className="muted">нет</div>}
        {cur.product_ids.map((id) => (
          <div key={id} className="row">
            <code>{id}</code>
            <Button onClick={() => save.mutate({ ...cur, product_ids: cur.product_ids.filter((x) => x !== id) })}>Вернуть</Button>
          </div>
        ))}
        <div className="row">
          <input className="input" placeholder="id блюда или ингредиента" value={pid} onChange={(e) => setPid(e.target.value)} />
          <Button onClick={() => { save.mutate({ ...cur, product_ids: [...cur.product_ids, pid] }); setPid(''); }} disabled={!pid}>
            Блюдо
          </Button>
          <Button onClick={() => { save.mutate({ ...cur, ingredient_ids: [...cur.ingredient_ids, pid] }); setPid(''); }} disabled={!pid}>
            Ингредиент
          </Button>
        </div>
      </Card>
      <Card>
        <h2>Недоступные ингредиенты</h2>
        {cur.ingredient_ids.length === 0 && <div className="muted">нет</div>}
        {cur.ingredient_ids.map((id) => (
          <div key={id} className="row">
            <code>{id}</code>
            <Button onClick={() => save.mutate({ ...cur, ingredient_ids: cur.ingredient_ids.filter((x) => x !== id) })}>Вернуть</Button>
          </div>
        ))}
      </Card>
      <Button danger onClick={() => confirm('Сбросить стоп-лист при открытии смены?') && save.mutate({ product_ids: [], ingredient_ids: [] })}>
        Сбросить стоп-лист (открытие смены)
      </Button>
    </>
  );
}
