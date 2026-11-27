import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ConsoleCouriersView, ConsoleOrdersView } from '@dark/contracts';
import { BRAND_RU, Badge, Button, COURIER_STATUS_RU, Card, ErrorBanner, Field, MapView, ORDER_STATUS_RU, somoni, statusTone, time, useStaff, type MapMarker } from '@dark/ui';

type Orders = z.infer<typeof ConsoleOrdersView>;
type Couriers = z.infer<typeof ConsoleCouriersView>;
type Order = Orders['orders'][number];

/** Пульт: все заказы точки по статусам, курьеры, ручное назначение, отмена, возврат, тревоги (ТЗ §9). */
export function Console({ storeId, storeGeo }: { storeId: string; storeGeo: { lat: number; lon: number } | null }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ['console-orders', storeId], queryFn: () => api.get<Orders>(`/console/stores/${storeId}/orders`) });
  const couriers = useQuery({ queryKey: ['console-couriers', storeId], queryFn: () => api.get<Couriers>(`/console/stores/${storeId}/couriers`) });
  const [selected, setSelected] = useState<Order | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['console-orders', storeId] });

  const groups: Record<string, Order[]> = {};
  for (const o of orders.data?.orders ?? []) (groups[o.status] ??= []).push(o);
  const alerts = (orders.data?.orders ?? []).filter((o) => (o.waiting_min ?? 0) >= 3);

  return (
    <>
      <ErrorBanner error={orders.error} />
      {alerts.length > 0 && (
        <div className="banner banner-error">
          Ждут курьера: {alerts.map((o) => `${o.number} (${o.waiting_min} мин)`).join(', ')}
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div style={{ flex: 3 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Бренд</th>
                <th>Статус</th>
                <th>Создан</th>
                <th>Обещано</th>
                <th>Курьер</th>
                <th>Сумма</th>
                <th>Адрес</th>
              </tr>
            </thead>
            <tbody>
              {['ready', 'on_the_way', 'picking', 'cooking', 'paid_hold', 'created', 'returning'].flatMap((st) =>
                (groups[st] ?? []).map((o) => (
                  <tr key={o.id} className="row-click" onClick={() => setSelected(o)}>
                    <td>
                      <b>{o.number}</b>
                    </td>
                    <td>{BRAND_RU[o.brand]}</td>
                    <td>
                      <Badge tone={statusTone(o.status)}>{ORDER_STATUS_RU[o.status]}</Badge>
                      {o.waiting_min != null && o.waiting_min > 0 && <span className="muted"> ждёт {o.waiting_min} мин</span>}
                    </td>
                    <td>{time(o.created_at)}</td>
                    <td>{time(o.promised_at)}</td>
                    <td>{o.courier ? `${o.courier.name} · ${o.courier.task_status}` : '—'}</td>
                    <td>{somoni(o.total_dirams)}</td>
                    <td className="muted">{o.address_short}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          {orders.data && orders.data.orders.length === 0 && <div className="empty">Активных заказов нет</div>}
        </div>
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {storeGeo && <MapView center={storeGeo} height={300} fit markers={mapMarkers(storeGeo, orders.data?.orders ?? [], couriers.data?.couriers ?? [])} />}
          <h2>Курьеры</h2>
          {(couriers.data?.couriers ?? []).map((c) => (
            <Card key={c.courier_id}>
              <div className="row">
                <b>{c.name}</b>
                <Badge tone={c.status === 'free' ? 'green' : c.status === 'offline' ? 'grey' : 'blue'}>{COURIER_STATUS_RU[c.status]}</Badge>
              </div>
              <div className="muted">
                {c.transport} · позиция {c.position_at ? time(c.position_at) : 'нет'}
              </div>
            </Card>
          ))}
          {couriers.data && couriers.data.couriers.length === 0 && <div className="empty">Курьеров на точке нет</div>}
        </div>
      </div>
      {selected && (
        <OrderActions
          storeId={storeId}
          order={selected}
          couriers={couriers.data?.couriers ?? []}
          onClose={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function OrderActions({ storeId, order, couriers, onClose }: { storeId: string; order: Order; couriers: Couriers['couriers']; onClose: () => void }) {
  const { api } = useStaff();
  const [courierId, setCourierId] = useState(couriers.find((c) => c.status === 'free')?.courier_id ?? '');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const act = useMutation({
    mutationFn: (p: { path: string; body: Record<string, unknown> }) => api.post(`/console/stores/${storeId}/orders/${order.id}/${p.path}`, p.body),
    onSuccess: onClose,
  });
  const canCancel = ['paid_hold', 'picking', 'cooking', 'ready'].includes(order.status);
  const canAssign = ['paid_hold', 'picking', 'cooking', 'ready'].includes(order.status);

  return (
    <div className="card" style={{ position: 'fixed', right: 16, bottom: 16, width: 380, zIndex: 5, boxShadow: '0 10px 40px #0008' }}>
      <div className="row">
        <h2>
          {order.number} · {ORDER_STATUS_RU[order.status]}
        </h2>
        <Button onClick={onClose}>✕</Button>
      </div>
      <ErrorBanner error={act.error} />
      <Field label="Причина (обязательна для любого действия)">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="например: срочный клиент" />
      </Field>
      {canAssign && (
        <>
          <Field label="Курьер">
            <select className="input" value={courierId} onChange={(e) => setCourierId(e.target.value)}>
              <option value="">— выбрать —</option>
              {couriers.map((c) => (
                <option key={c.courier_id} value={c.courier_id}>
                  {c.name} · {COURIER_STATUS_RU[c.status]}
                </option>
              ))}
            </select>
          </Field>
          <Button primary disabled={!courierId || !reason || act.isPending} onClick={() => act.mutate({ path: 'assign', body: { courier_id: courierId, reason } })}>
            Назначить вручную
          </Button>
        </>
      )}
      {canCancel && (
        <Button danger disabled={!reason || act.isPending} onClick={() => act.mutate({ path: 'cancel', body: { reason } })}>
          Отменить заказ
        </Button>
      )}
      {order.status === 'on_the_way' && (
        <Button disabled={!reason || act.isPending} onClick={() => act.mutate({ path: 'delivered', body: { reason } })}>
          Подтвердить доставку (курьер вне геозоны)
        </Button>
      )}
      {order.status === 'returning' && (
        <Button primary disabled={act.isPending} onClick={() => act.mutate({ path: 'returned', body: { comment: reason } })}>
          Пакет принят на точке
        </Button>
      )}
      {['delivered', 'returned'].includes(order.status) && (
        <>
          <Field label="Возврат, сомони">
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Button
            disabled={!reason || !amount || act.isPending}
            onClick={() => act.mutate({ path: 'refund', body: { amount_dirams: Math.round(Number(amount.replace(',', '.')) * 100), reason } })}
          >
            Вернуть деньги
          </Button>
        </>
      )}
    </div>
  );
}

/** Точка — синяя, курьеры — зелёные (свободен) или оранжевые (в работе), адреса заказов — по статусу. */
function mapMarkers(store: { lat: number; lon: number }, orders: Order[], couriers: Couriers['couriers']): MapMarker[] {
  const out: MapMarker[] = [{ id: 'store', ...store, color: '#4f8cff', label: 'Точка' }];
  for (const c of couriers) if (c.position) out.push({ id: c.courier_id, ...c.position, color: c.status === 'free' ? '#3ccf7a' : '#ff9f43', label: c.name.split(' ').pop() ?? c.name, title: c.status });
  for (const o of orders) if (o.geo && ['ready', 'on_the_way', 'picking', 'cooking'].includes(o.status)) out.push({ id: o.id, ...o.geo, color: o.status === 'on_the_way' ? '#8fb3ff' : '#ff5b5b', radius: 6, title: `${o.number} · ${ORDER_STATUS_RU[o.status]}` });
  return out;
}
