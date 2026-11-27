import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { PromoListView } from '@dark/contracts';
import { BRAND_RU, Badge, Button, Card, ErrorBanner, Field, dateTime, somoni, useStaff } from '@dark/ui';

/** Промокоды: тип, аудитория, лимит на клиента, бюджет с остатком. */
export function Promos() {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['promos'], queryFn: () => api.get<z.infer<typeof PromoListView>>('/admin/promos') });
  const [f, setF] = useState({ code: '', type: 'percent', value: '10', audience: 'all', per_customer_limit: '1', budget: '', valid_to: '' });
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.post('/admin/promos', {
        code: f.code.toUpperCase(),
        type: f.type,
        value: f.type === 'fixed' ? Math.round(Number(f.value) * 100) : Number(f.value),
        audience: f.audience,
        per_customer_limit: Number(f.per_customer_limit),
        budget_dirams: f.budget ? Math.round(Number(f.budget) * 100) : null,
        valid_to: f.valid_to ? new Date(f.valid_to).toISOString() : null,
      }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['promos'] });
    },
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/promos/${id}`, { valid_to: new Date().toISOString(), reason: 'остановлен вручную' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['promos'] }),
  });
  const valueText = (t: string, v: number) => (t === 'percent' ? `${v} %` : t === 'fixed' ? somoni(v) : 'бесплатная доставка');
  return (
    <>
      <div className="row">
        <h2>Промокоды</h2>
        <Button primary onClick={() => setOpen(true)}>
          + Промокод
        </Button>
      </div>
      <ErrorBanner error={q.error ?? stop.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Скидка</th>
            <th>Бренд</th>
            <th>Аудитория</th>
            <th>Использований</th>
            <th>Бюджет</th>
            <th>До</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(q.data?.promos ?? []).map((p) => {
            const expired = p.valid_to && new Date(p.valid_to) < new Date();
            return (
              <tr key={p.id}>
                <td>
                  <b>{p.code}</b> {expired && <Badge tone="grey">завершён</Badge>}
                </td>
                <td>{valueText(p.type, p.value)}</td>
                <td>{p.brand ? BRAND_RU[p.brand] : 'оба'}</td>
                <td>{{ new: 'новые', all: 'все', segment: 'сегмент' }[p.audience]}</td>
                <td>{p.uses}</td>
                <td>{p.budget_dirams ? `${somoni(p.spent_dirams)} / ${somoni(p.budget_dirams)}` : '—'}</td>
                <td>{dateTime(p.valid_to)}</td>
                <td>{!expired && <Button onClick={() => stop.mutate(p.id)}>Остановить</Button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && (
        <div className="modal">
          <Card>
            <div className="row">
              <h2>Новый промокод</h2>
              <Button onClick={() => setOpen(false)}>✕</Button>
            </div>
            <ErrorBanner error={create.error} />
            <div className="grid">
              <Field label="Код">
                <input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Тип">
                <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                  <option value="percent">процент</option>
                  <option value="fixed">фиксированная, сомони</option>
                  <option value="free_delivery">бесплатная доставка</option>
                </select>
              </Field>
              {f.type !== 'free_delivery' && (
                <Field label={f.type === 'percent' ? 'Процент' : 'Сумма, сомони'}>
                  <input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
                </Field>
              )}
              <Field label="Аудитория">
                <select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
                  <option value="all">все</option>
                  <option value="new">новые клиенты</option>
                </select>
              </Field>
              <Field label="Раз на клиента">
                <input className="input" value={f.per_customer_limit} onChange={(e) => setF({ ...f, per_customer_limit: e.target.value })} />
              </Field>
              <Field label="Бюджет, сомони (пусто — без лимита)">
                <input className="input" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
              </Field>
              <Field label="Действует до">
                <input className="input" type="datetime-local" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
              </Field>
            </div>
            <Button primary disabled={!f.code || create.isPending} onClick={() => create.mutate()}>
              Создать
            </Button>
          </Card>
        </div>
      )}
    </>
  );
}
