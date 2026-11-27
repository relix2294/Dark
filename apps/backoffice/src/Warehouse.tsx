import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { CellListView, ProductListView, StockListView, SupplyListView } from '@dark/contracts';
import { Badge, Button, Card, ErrorBanner, Field, dateTime, useStaff } from '@dark/ui';

type Tab = 'stock' | 'cells' | 'supplies';

/** Склад точки: остатки, ячейки, документы поставки (ТЗ §7). */
export function Warehouse({ storeId }: { storeId: string }) {
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <>
      <div className="tabs">
        {(['stock', 'cells', 'supplies'] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? ' tab-active' : ''}`} onClick={() => setTab(t)}>
            {{ stock: 'Остатки', cells: 'Ячейки', supplies: 'Поставки' }[t]}
          </button>
        ))}
      </div>
      {tab === 'stock' ? <Stock storeId={storeId} /> : tab === 'cells' ? <Cells storeId={storeId} /> : <Supplies storeId={storeId} />}
    </>
  );
}

function Stock({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const q = useQuery({ queryKey: ['stock', storeId], queryFn: () => api.get<z.infer<typeof StockListView>>(`/admin/stores/${storeId}/stock`) });
  const soon = Date.now() + 2 * 86_400_000;
  return (
    <>
      <ErrorBanner error={q.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Товар</th>
            <th>Остаток</th>
            <th>В резерве</th>
            <th>Не размещено</th>
            <th>Ближайший срок</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.rows ?? []).map((r) => (
            <tr key={r.product_id}>
              <td>
                {r.name} <span className="muted">{r.sku}</span>
              </td>
              <td>{r.qty === 0 ? <Badge tone="red">0</Badge> : r.qty}</td>
              <td>{r.reserved_qty}</td>
              <td>{r.unplaced_qty > 0 ? <Badge tone="yellow">{r.unplaced_qty}</Badge> : 0}</td>
              <td>{r.nearest_expiry ? <span className={new Date(r.nearest_expiry).getTime() < soon ? 'badge badge-red' : ''}>{dateTime(r.nearest_expiry)}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Cells({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cells', storeId], queryFn: () => api.get<z.infer<typeof CellListView>>(`/admin/stores/${storeId}/cells`) });
  const [f, setF] = useState({ code: '', pick_seq: '', temp_zone: 'ambient', is_camera_covered: false, capacity_units: '100' });
  const add = useMutation({
    mutationFn: () => api.post(`/admin/stores/${storeId}/cells`, { code: f.code, pick_seq: Number(f.pick_seq), temp_zone: f.temp_zone, is_camera_covered: f.is_camera_covered, capacity_units: Number(f.capacity_units) }),
    onSuccess: () => {
      setF({ ...f, code: '', pick_seq: String(Number(f.pick_seq) + 1) });
      void qc.invalidateQueries({ queryKey: ['cells', storeId] });
    },
  });
  return (
    <>
      <Card>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Field label="Код (A-03-2)">
            <input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Порядок обхода">
            <input className="input" value={f.pick_seq} onChange={(e) => setF({ ...f, pick_seq: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Зона">
            <select className="input" value={f.temp_zone} onChange={(e) => setF({ ...f, temp_zone: e.target.value })}>
              <option value="ambient">обычная</option>
              <option value="chill">холод</option>
              <option value="frozen">заморозка</option>
            </select>
          </Field>
          <Field label="Вместимость">
            <input className="input" value={f.capacity_units} onChange={(e) => setF({ ...f, capacity_units: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={f.is_camera_covered} onChange={(e) => setF({ ...f, is_camera_covered: e.target.checked })} /> под камерой
          </label>
          <Button primary disabled={!f.code || !f.pick_seq || add.isPending} onClick={() => add.mutate()}>
            Добавить
          </Button>
        </div>
        <ErrorBanner error={add.error} />
      </Card>
      <table className="table">
        <thead>
          <tr>
            <th>№ обхода</th>
            <th>Ячейка</th>
            <th>Зона</th>
            <th>Заполнено</th>
            <th>Камера</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.cells ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.pick_seq}</td>
              <td>
                <b>{c.code}</b>
              </td>
              <td className="muted">{c.temp_zone}</td>
              <td>
                {c.used_units} / {c.capacity_units}
              </td>
              <td>{c.is_camera_covered ? '📷' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Supplies({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['supplies', storeId], queryFn: () => api.get<z.infer<typeof SupplyListView>>(`/admin/stores/${storeId}/supplies`) });
  const [supplier, setSupplier] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<{ product_id: string; name: string; qty: string }[]>([]);
  const found = useQuery({
    queryKey: ['supply-search', search],
    enabled: search.length >= 2,
    queryFn: () => api.get<z.infer<typeof ProductListView>>(`/admin/products?brand=LAB&limit=10&q=${encodeURIComponent(search)}`),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/admin/stores/${storeId}/supplies`, { supplier, items: lines.map((l) => ({ product_id: l.product_id, qty_expected: Number(l.qty) })) }),
    onSuccess: () => {
      setLines([]);
      setSupplier('');
      void qc.invalidateQueries({ queryKey: ['supplies', storeId] });
    },
  });
  return (
    <>
      <Card>
        <h2>Новый документ поставки</h2>
        <Field label="Поставщик">
          <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field label="Добавить товар">
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="название или штрихкод" />
        </Field>
        {(found.data?.products ?? []).map((p) => (
          <div key={p.id} className="row">
            <span>{p.name_ru}</span>
            <Button onClick={() => { setLines([...lines, { product_id: p.id, name: p.name_ru, qty: '1' }]); setSearch(''); }}>+</Button>
          </div>
        ))}
        {lines.map((l, i) => (
          <div key={i} className="row">
            <span>{l.name}</span>
            <input className="input" style={{ width: 100 }} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
            <Button onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
        <ErrorBanner error={create.error} />
        <Button primary disabled={!supplier || lines.length === 0 || create.isPending} onClick={() => create.mutate()}>
          Создать документ
        </Button>
      </Card>
      <table className="table">
        <thead>
          <tr>
            <th>Документ</th>
            <th>Поставщик</th>
            <th>Строк</th>
            <th>Статус</th>
            <th>Создан</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.supplies ?? []).map((s) => (
            <tr key={s.id}>
              <td>
                <code title="этот id вводится на терминале при приёмке">{s.id}</code>
              </td>
              <td>{s.supplier}</td>
              <td>{s.lines}</td>
              <td>
                <Badge tone={s.status === 'expected' ? 'grey' : 'yellow'}>{s.status}</Badge>
              </td>
              <td>{dateTime(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
