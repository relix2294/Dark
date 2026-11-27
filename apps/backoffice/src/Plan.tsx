import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { CourierPlanView } from '@dark/contracts';
import { Badge, Button, ErrorBanner, useStaff } from '@dark/ui';

/** График курьеров по часам: прогноз заказов по истории, сколько нужно и сколько запланировано. */
export function Plan({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(tomorrow);
  const q = useQuery({ queryKey: ['plan', storeId, date], queryFn: () => api.get<z.infer<typeof CourierPlanView>>(`/admin/stores/${storeId}/courier-plan?date=${date}`), refetchInterval: false });
  const [planned, setPlanned] = useState<Record<number, number>>({});
  useEffect(() => setPlanned(Object.fromEntries((q.data?.rows ?? []).map((r) => [r.hour, r.couriers_planned]))), [q.data]);
  const save = useMutation({
    mutationFn: () => api.put(`/admin/stores/${storeId}/courier-plan?date=${date}`, { rows: Object.entries(planned).map(([h, n]) => ({ hour: Number(h), couriers_planned: n })) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plan', storeId, date] }),
  });
  const rows = (q.data?.rows ?? []).filter((r) => r.hour >= 7);
  return (
    <>
      <div className="row">
        <input className="input" type="date" style={{ maxWidth: 200 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <Button primary disabled={save.isPending} onClick={() => save.mutate()}>
          Сохранить план
        </Button>
      </div>
      <ErrorBanner error={q.error ?? save.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Час</th>
            <th>Прогноз Lablabu</th>
            <th>Прогноз Sor Box</th>
            <th>Нужно курьеров</th>
            <th>В плане</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = planned[r.hour] ?? 0;
            return (
              <tr key={r.hour}>
                <td>{String(r.hour).padStart(2, '0')}:00</td>
                <td>{r.forecast_orders_lab}</td>
                <td>{r.forecast_orders_sor}</td>
                <td>{r.couriers_needed}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-start' }}>
                    <Button onClick={() => setPlanned({ ...planned, [r.hour]: Math.max(0, p - 1) })}>−</Button>
                    <b>{p}</b>
                    <Button onClick={() => setPlanned({ ...planned, [r.hour]: p + 1 })}>+</Button>
                    {p < r.couriers_needed && <Badge tone="red">не хватает {r.couriers_needed - p}</Badge>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
