import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type { MoneyReport, ReportSummary } from '@dark/contracts';
import { BRAND_RU, Badge, Card, ErrorBanner, ORDER_STATUS_RU, dateTime, somoni, useStaff } from '@dark/ui';

/** Отчёты: сводка за период и «Деньги» (только финансист и управляющий). */
export function Reports({ storeId }: { storeId: string }) {
  const { api, session } = useStaff();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ['report', storeId, from, to], queryFn: () => api.get<z.infer<typeof ReportSummary>>(`/admin/reports/summary?store_id=${storeId}&from=${from}&to=${to}`) });
  const canMoney = ['finance', 'manager'].includes(session.principal.role);
  const money = useQuery({ queryKey: ['money', storeId], enabled: canMoney, queryFn: () => api.get<z.infer<typeof MoneyReport>>(`/admin/reports/money/${storeId}`) });
  const r = q.data;
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <input className="input" type="date" style={{ maxWidth: 180 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>—</span>
        <input className="input" type="date" style={{ maxWidth: 180 }} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <ErrorBanner error={q.error} />
      {r && (
        <>
          <div className="grid">
            <Card>
              <div className="muted">Заказов</div>
              <div className="big">{r.orders_total}</div>
            </Card>
            {r.by_brand.map((b) => (
              <Card key={b.brand}>
                <div className="muted">{BRAND_RU[b.brand]}</div>
                <div className="big">{somoni(b.captured_dirams)}</div>
                <div className="muted">
                  доставлено {b.delivered} · средний чек {somoni(b.avg_check_dirams)} · вовремя {b.on_time_pct} %
                </div>
              </Card>
            ))}
            <Card>
              <div className="muted">Возвраты / скидки</div>
              <div className="big">{somoni(r.refunds_dirams)}</div>
              <div className="muted">скидки {somoni(r.discounts_dirams)} · списаний {r.write_offs}</div>
            </Card>
            <Card>
              <div className="muted">Средняя сборка</div>
              <div className="big">{r.avg_pick_sec != null ? `${Math.floor(r.avg_pick_sec / 60)}:${String(r.avg_pick_sec % 60).padStart(2, '0')}` : '—'}</div>
              <div className="muted">норматив 2:00</div>
            </Card>
            <Card>
              <div className="muted">Оценка клиентов</div>
              <div className="big">{r.rating ? `${r.rating.avg.toFixed(1)} ★` : '—'}</div>
              <div className="muted">{r.rating ? `оценок ${r.rating.count} · низких (≤ 3) ${r.rating.low}` : 'оценок пока нет'}</div>
            </Card>
          </div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <table className="table" style={{ flex: 1 }}>
              <thead>
                <tr>
                  <th>День</th>
                  <th>Заказов</th>
                  <th>Выручка</th>
                </tr>
              </thead>
              <tbody>
                {r.daily.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.orders}</td>
                    <td>{somoni(d.captured_dirams)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="table" style={{ flex: 1 }}>
              <thead>
                <tr>
                  <th>Сборщик</th>
                  <th>Заданий</th>
                  <th>Среднее</th>
                </tr>
              </thead>
              <tbody>
                {r.pickers.map((p) => (
                  <tr key={p.staff_id}>
                    <td>{p.name}</td>
                    <td>{p.tasks}</td>
                    <td>{p.avg_sec > 120 ? <Badge tone="red">{p.avg_sec} с</Badge> : `${p.avg_sec} с`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="table" style={{ flex: 1 }}>
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Заказов</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(r.orders_by_status).map(([s, n]) => (
                  <tr key={s}>
                    <td>{ORDER_STATUS_RU[s] ?? s}</td>
                    <td>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {canMoney && money.data && (
        <Card>
          <h2>Деньги</h2>
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {Object.entries(money.data.payments_by_status).map(([s, v]) => (
              <Badge key={s} tone={s.endsWith('pending') || s === 'failed' ? 'red' : 'grey'}>
                {s}: {v.count} · {somoni(v.dirams)}
              </Badge>
            ))}
          </div>
          {money.data.pending_over_5min.length > 0 && (
            <>
              <h2>Зависли больше 5 минут</h2>
              {money.data.pending_over_5min.map((p) => (
                <div key={p.payment_id} className="banner banner-error">
                  {p.status} с {dateTime(p.since)} · заказ {p.order_id.slice(0, 8)} · {p.last_error ?? ''}
                </div>
              ))}
            </>
          )}
          {money.data.failed_ops.length > 0 && (
            <>
              <h2>Неуспешные операции</h2>
              {money.data.failed_ops.map((o) => (
                <div key={o.key} className="row">
                  <code>{o.key}</code>
                  <span>
                    {o.type} {somoni(o.amount_dirams)} · {dateTime(o.at)}
                  </span>
                </div>
              ))}
            </>
          )}
        </Card>
      )}
    </>
  );
}
