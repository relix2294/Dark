import { useQuery } from '@tanstack/react-query';
import { ErrorBanner, dateTime, useStaff } from '@dark/ui';

type Row = { id: string; createdAt: string; actorType: string; actorId: string | null; action: string; objectType: string; objectId: string; before: unknown; after: unknown; reason: string | null };

/** Журнал действий: кто, когда, действие, объект, было, стало, причина (ТЗ §10). */
export function Audit() {
  const { api } = useStaff();
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api.get<Row[]>('/backoffice/audit') });
  return (
    <>
      <ErrorBanner error={q.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Когда</th>
            <th>Кто</th>
            <th>Действие</th>
            <th>Объект</th>
            <th>Было → стало</th>
            <th>Причина</th>
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{dateTime(r.createdAt)}</td>
              <td className="muted">{r.actorId?.slice(0, 8) ?? r.actorType}</td>
              <td>
                <code>{r.action}</code>
              </td>
              <td className="muted">
                {r.objectType} {r.objectId.slice(0, 8)}
              </td>
              <td>
                {r.before != null && <span className="muted">{JSON.stringify(r.before)} → </span>}
                {JSON.stringify(r.after)}
              </td>
              <td>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
