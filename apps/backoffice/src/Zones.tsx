import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { ZoneListView, ZoneView } from '@dark/contracts';
import { BRAND_RU, Badge, Button, Card, ErrorBanner, Field, somoni, useStaff } from '@dark/ui';

type Zone = z.infer<typeof ZoneView>;

/** Зоны доставки точки: тариф, минимальный заказ, время. Полигон — JSON [[lon, lat], …] (редактор на карте — следующий шаг). */
export function Zones({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['zones', storeId], queryFn: () => api.get<z.infer<typeof ZoneListView>>(`/admin/stores/${storeId}/zones`) });
  const [edit, setEdit] = useState<Zone | 'new' | null>(null);
  return (
    <>
      <div className="row">
        <h2>Зоны доставки</h2>
        <Button primary onClick={() => setEdit('new')}>
          + Зона
        </Button>
      </div>
      <ErrorBanner error={q.error} />
      <div className="grid">
        {(q.data?.zones ?? []).map((zn) => (
          <Card key={zn.id} tone={zn.is_active ? undefined : 'grey'} onClick={() => setEdit(zn)}>
            <div className="row">
              <b>{BRAND_RU[zn.brand]}</b>
              {!zn.is_active && <Badge tone="red">выключена</Badge>}
            </div>
            <div>
              Доставка {somoni(zn.fee_dirams)} · минимум {somoni(zn.min_order_dirams)}
            </div>
            <div className="muted">
              {zn.eta_min}–{zn.eta_max} мин · {zn.polygon.length} точек полигона
            </div>
          </Card>
        ))}
      </div>
      {edit && <ZoneEditor storeId={storeId} zone={edit === 'new' ? null : edit} onClose={() => { setEdit(null); void qc.invalidateQueries({ queryKey: ['zones', storeId] }); }} />}
    </>
  );
}

function ZoneEditor({ storeId, zone, onClose }: { storeId: string; zone: Zone | null; onClose: () => void }) {
  const { api } = useStaff();
  const [f, setF] = useState({
    brand: zone?.brand ?? 'LAB',
    fee: zone ? String(zone.fee_dirams / 100) : '10',
    min: zone ? String(zone.min_order_dirams / 100) : '30',
    eta_min: String(zone?.eta_min ?? 10),
    eta_max: String(zone?.eta_max ?? 20),
    polygon: JSON.stringify(zone?.polygon ?? []),
    is_active: zone?.is_active ?? true,
    reason: '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        brand: f.brand,
        fee_dirams: Math.round(Number(f.fee) * 100),
        min_order_dirams: Math.round(Number(f.min) * 100),
        eta_min: Number(f.eta_min),
        eta_max: Number(f.eta_max),
        polygon: JSON.parse(f.polygon) as [number, number][],
        is_active: f.is_active,
      };
      return zone ? api.patch(`/admin/stores/${storeId}/zones/${zone.id}`, { ...body, reason: f.reason }) : api.post(`/admin/stores/${storeId}/zones`, body);
    },
    onSuccess: onClose,
  });
  return (
    <div className="modal">
      <Card>
        <div className="row">
          <h2>{zone ? 'Зона' : 'Новая зона'}</h2>
          <Button onClick={onClose}>✕</Button>
        </div>
        <ErrorBanner error={save.error} />
        <div className="grid">
          <Field label="Бренд">
            <select className="input" value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value as 'LAB' | 'SOR' })}>
              <option value="LAB">Lablabu</option>
              <option value="SOR">Sor Box</option>
            </select>
          </Field>
          <Field label="Доставка, сомони">
            <input className="input" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          </Field>
          <Field label="Минимальный заказ, сомони">
            <input className="input" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} />
          </Field>
          <Field label="Время от, мин">
            <input className="input" value={f.eta_min} onChange={(e) => setF({ ...f, eta_min: e.target.value })} />
          </Field>
          <Field label="Время до, мин">
            <input className="input" value={f.eta_max} onChange={(e) => setF({ ...f, eta_max: e.target.value })} />
          </Field>
        </div>
        <Field label="Полигон [[lon, lat], …]">
          <textarea className="input" rows={4} value={f.polygon} onChange={(e) => setF({ ...f, polygon: e.target.value })} />
        </Field>
        <label className="row" style={{ justifyContent: 'flex-start', gap: 6 }}>
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> зона активна
        </label>
        {zone && (
          <Field label="Причина изменения (в журнал)">
            <input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </Field>
        )}
        <Button primary disabled={save.isPending || (!!zone && !f.reason)} onClick={() => save.mutate()}>
          Сохранить
        </Button>
      </Card>
    </div>
  );
}
