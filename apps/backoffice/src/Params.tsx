import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorBanner, Field, useStaff } from '@dark/ui';

/** Настраиваемые параметры точки (ТЗ §12): меняются без выкладки кода, с причиной в журнал. */
export function Params({ storeId }: { storeId: string }) {
  const { api, session } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['params', storeId], queryFn: () => api.get<Record<string, unknown>>(`/backoffice/stores/${storeId}/params`), refetchInterval: false });
  const [edit, setEdit] = useState<{ key: string; value: string; reason: string } | null>(null);
  const save = useMutation({
    mutationFn: (p: { key: string; value: unknown; reason: string }) => api.put(`/backoffice/stores/${storeId}/params`, p),
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['params', storeId] });
    },
  });
  const canEdit = ['manager', 'admin'].includes(session.principal.role);

  return (
    <>
      <ErrorBanner error={q.error ?? save.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Параметр</th>
            <th>Значение</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Object.entries(q.data ?? {}).map(([k, v]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
              <td>{canEdit && <Button onClick={() => setEdit({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v), reason: '' })}>Изменить</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <div className="card" style={{ maxWidth: 480 }}>
          <h2>{edit.key}</h2>
          <Field label="Новое значение (число, true/false или JSON)">
            <input className="input" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
          </Field>
          <Field label="Причина">
            <input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
          </Field>
          <div className="row">
            <Button onClick={() => setEdit(null)}>Отмена</Button>
            <Button primary disabled={!edit.reason || save.isPending} onClick={() => save.mutate({ key: edit.key, value: parseValue(edit.value), reason: edit.reason })}>
              Сохранить
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function parseValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
