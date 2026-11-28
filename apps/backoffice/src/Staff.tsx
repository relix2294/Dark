import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { StaffListView, StaffRole, StaffView } from '@dark/contracts';
import { Badge, Button, Card, ErrorBanner, Field, useStaff } from '@dark/ui';

type Person = z.infer<typeof StaffView>;
const ROLE_RU: Record<StaffRole, string> = {
  picker: 'Сборщик',
  cook: 'Повар',
  courier: 'Курьер',
  shift_lead: 'Старший смены',
  manager: 'Управляющий',
  finance: 'Финансист',
  admin: 'Админ',
};

/** Персонал точки: заведение, роли, блокировка, смена PIN. Каждое изменение — с причиной в журнал. */
export function Staff({ storeId }: { storeId: string }) {
  const { api, session } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['staff', storeId], queryFn: () => api.get<z.infer<typeof StaffListView>>(`/admin/staff?store_id=${storeId}`) });
  const [edit, setEdit] = useState<Person | 'new' | null>(null);
  const isAdmin = session.principal.role === 'admin';
  const roles: StaffRole[] = isAdmin ? ['picker', 'cook', 'courier', 'shift_lead', 'manager', 'finance', 'admin'] : ['picker', 'cook', 'courier', 'shift_lead'];
  return (
    <>
      <div className="row">
        <h2>Персонал</h2>
        <Button primary onClick={() => setEdit('new')}>
          + Сотрудник
        </Button>
      </div>
      <ErrorBanner error={q.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Телефон</th>
            <th>Роль</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.staff ?? []).map((p) => (
            <tr key={p.id} className="row-click" onClick={() => setEdit(p)}>
              <td>{p.name}</td>
              <td className="muted">{p.phone}</td>
              <td>{ROLE_RU[p.role]}</td>
              <td>{p.is_active ? <Badge tone="green">активен</Badge> : <Badge tone="red">заблокирован</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <Editor storeId={storeId} roles={roles} person={edit === 'new' ? null : edit} onClose={() => { setEdit(null); void qc.invalidateQueries({ queryKey: ['staff', storeId] }); }} />}
    </>
  );
}

function Editor({ storeId, roles, person, onClose }: { storeId: string; roles: StaffRole[]; person: Person | null; onClose: () => void }) {
  const { api } = useStaff();
  const [f, setF] = useState({ name: person?.name ?? '', phone: person?.phone ?? '+992', role: person?.role ?? 'picker', pin: '', is_active: person?.is_active ?? true, reason: '', dc: person?.dc_user_id ?? '' });
  const save = useMutation({
    mutationFn: () =>
      person
        ? api.patch(`/admin/staff/${person.id}`, {
            name: f.name,
            ...(f.role !== person.role ? { role: f.role } : {}),
            ...(f.is_active !== person.is_active ? { is_active: f.is_active } : {}),
            ...(f.pin ? { pin: f.pin } : {}),
            ...(f.dc.trim() !== (person.dc_user_id ?? '') ? { dc_user_id: f.dc.trim() || null } : {}),
            reason: f.reason,
          })
        : api.post('/admin/staff', { name: f.name, phone: f.phone, role: f.role, pin: f.pin, store_id: ['finance', 'admin'].includes(f.role) ? null : storeId, ...(f.dc.trim() ? { dc_user_id: f.dc.trim() } : {}) }),
    onSuccess: onClose,
  });
  return (
    <div className="modal">
      <Card>
        <div className="row">
          <h2>{person ? person.name : 'Новый сотрудник'}</h2>
          <Button onClick={onClose}>✕</Button>
        </div>
        <ErrorBanner error={save.error} />
        <div className="grid">
          <Field label="Имя">
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Телефон">
            <input className="input" value={f.phone} disabled={!!person} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Роль">
            <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as StaffRole })}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_RU[r]}
                </option>
              ))}
            </select>
          </Field>
          {f.role === 'courier' && (
            <Field label="Кошелёк DC (для выплат — только безналично)">
              <input className="input" value={f.dc} onChange={(e) => setF({ ...f, dc: e.target.value })} placeholder="id пользователя DC" />
            </Field>
          )}
          <Field label={person ? 'Новый PIN (пусто — без изменений)' : 'PIN'}>
            <input className="input" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
          </Field>
        </div>
        {person && (
          <>
            <label className="row" style={{ justifyContent: 'flex-start', gap: 6 }}>
              <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> доступ разрешён
            </label>
            <Field label="Причина (в журнал)">
              <input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </Field>
          </>
        )}
        <Button primary disabled={save.isPending || !f.name || (!person && f.pin.length < 4) || (!!person && !f.reason)} onClick={() => save.mutate()}>
          Сохранить
        </Button>
      </Card>
    </div>
  );
}
