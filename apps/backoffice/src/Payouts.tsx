import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { ConsoleCouriersView, PayoutListView, PayoutStatus } from '@dark/contracts';
import { Badge, Button, Card, ErrorBanner, Field, dateTime, somoni, useStaff } from '@dark/ui';

type Row = z.infer<typeof PayoutListView>['payouts'][number];

const STATUS_RU: Record<PayoutStatus, string> = { pending: 'в очереди', sent: 'выплачено на DC', failed: 'не прошла', no_wallet: 'нет кошелька DC' };
const STATUS_TONE: Record<PayoutStatus, 'grey' | 'green' | 'red' | 'yellow'> = { pending: 'grey', sent: 'green', failed: 'red', no_wallet: 'yellow' };

/** Выплаты курьерам за смены и доплаты — только безналично, на кошелёк DC. Повтор неудачных, доплата с причиной. */
export function Payouts({ storeId }: { storeId: string }) {
  const { api, session } = useStaff();
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ['payouts', storeId, from, to], queryFn: () => api.get<z.infer<typeof PayoutListView>>(`/admin/stores/${storeId}/payouts?from=${from}&to=${to}`) });
  // курьеры точки для доплаты: с пульта (управляющий) и из выплат периода (финансист)
  const live = useQuery({
    queryKey: ['console-couriers', storeId],
    enabled: session.principal.role === 'manager',
    queryFn: () => api.get<z.infer<typeof ConsoleCouriersView>>(`/console/stores/${storeId}/couriers`),
  });
  const couriers = new Map<string, string>();
  for (const c of live.data?.couriers ?? []) couriers.set(c.courier_id, c.name);
  for (const p of q.data?.payouts ?? []) couriers.set(p.courier_id, p.courier_name);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['payouts', storeId] });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/admin/payouts/${id}/retry`), onSuccess: refresh });
  const [bonus, setBonus] = useState({ courier: '', amount: '', reason: '' });
  const giveBonus = useMutation({
    mutationFn: () => api.post(`/admin/couriers/${bonus.courier}/bonus`, { amount_dirams: Math.round(Number(bonus.amount.replace(',', '.')) * 100), reason: bonus.reason }),
    onSuccess: () => {
      setBonus({ courier: '', amount: '', reason: '' });
      refresh();
    },
  });
  const t = q.data?.totals;
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <input className="input" type="date" style={{ maxWidth: 180 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>—</span>
        <input className="input" type="date" style={{ maxWidth: 180 }} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <ErrorBanner error={q.error ?? retry.error} />
      {t && (
        <div className="grid">
          <Card>
            <div className="muted">Выплачено на DC</div>
            <div className="big">{somoni(t.sent_dirams)}</div>
          </Card>
          <Card>
            <div className="muted">В очереди</div>
            <div className="big">{somoni(t.pending_dirams)}</div>
          </Card>
          <Card tone={t.problem_dirams > 0 ? 'red' : undefined}>
            <div className="muted">Требуют внимания</div>
            <div className="big">{somoni(t.problem_dirams)}</div>
            <div className="muted">нет кошелька DC или банк отказал</div>
          </Card>
        </div>
      )}
      <Card>
        <h2>Доплата курьеру</h2>
        <div className="muted">Отдельная выплата на кошелёк DC, с причиной — в журнал. Наличных нет.</div>
        <ErrorBanner error={giveBonus.error} />
        <div className="grid">
          <Field label="Курьер">
            <select className="input" value={bonus.courier} onChange={(e) => setBonus({ ...bonus, courier: e.target.value })}>
              <option value="">— выбрать —</option>
              {[...couriers].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Сумма, сомони">
            <input className="input" inputMode="decimal" value={bonus.amount} onChange={(e) => setBonus({ ...bonus, amount: e.target.value })} />
          </Field>
          <Field label="Причина">
            <input className="input" value={bonus.reason} onChange={(e) => setBonus({ ...bonus, reason: e.target.value })} placeholder="например: работа в дождь" />
          </Field>
        </div>
        <Button primary disabled={!bonus.courier || !(Number(bonus.amount.replace(',', '.')) >= 1) || !bonus.reason || giveBonus.isPending} onClick={() => giveBonus.mutate()}>
          Доплатить
        </Button>
      </Card>
      <table className="table">
        <thead>
          <tr>
            <th>Когда</th>
            <th>Курьер</th>
            <th>За что</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(q.data?.payouts ?? []).map((p) => (
            <tr key={p.id}>
              <td>{dateTime(p.created_at)}</td>
              <td>{p.courier_name}</td>
              <td className="muted">{describe(p)}</td>
              <td>
                <b>{somoni(p.amount_dirams)}</b>
              </td>
              <td>
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_RU[p.status]}</Badge>
                {p.last_error && p.status !== 'sent' && <div className="muted">{p.last_error}</div>}
              </td>
              <td>
                {(p.status === 'failed' || p.status === 'no_wallet') && (
                  <Button disabled={retry.isPending} onClick={() => retry.mutate(p.id)}>
                    Повторить
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data && q.data.payouts.length === 0 && <div className="empty">Выплат за период нет</div>}
    </>
  );
}

function describe(p: Row): string {
  if (p.kind === 'bonus') return `доплата: ${p.reason ?? ''}`;
  const b = p.breakdown ?? {};
  const parts = [`смена: доставок ${(b['delivered'] ?? 0) + (b['returned'] ?? 0)}`, `${b['km'] ?? 0} км`, `${Math.round((b['minutes'] ?? 0) / 6) / 10} ч`];
  return parts.join(' · ');
}
