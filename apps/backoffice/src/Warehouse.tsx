import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { CellListView, ExpiringView, ProductListView, StockListView, StocktakeListView, SupplyListView } from '@dark/contracts';
import { Badge, Button, Card, ErrorBanner, Field, dateTime, useStaff } from '@dark/ui';

type Tab = 'stock' | 'expiring' | 'stocktake' | 'cells' | 'supplies';

/** Склад точки: остатки, ячейки, документы поставки (ТЗ §7). */
export function Warehouse({ storeId }: { storeId: string }) {
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <>
      <div className="tabs">
        {(['stock', 'expiring', 'stocktake', 'cells', 'supplies'] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? ' tab-active' : ''}`} onClick={() => setTab(t)}>
            {{ stock: 'Остатки', expiring: 'Сроки', stocktake: 'Инвентаризация', cells: 'Ячейки', supplies: 'Поставки' }[t]}
          </button>
        ))}
      </div>
      {
        {
          stock: <Stock storeId={storeId} />,
          expiring: <Expiring storeId={storeId} />,
          stocktake: <Stocktakes storeId={storeId} />,
          cells: <Cells storeId={storeId} />,
          supplies: <Supplies storeId={storeId} />,
        }[tab]
      }
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
              <td>{r.qty === 0 ? <Badge tone="red">0</Badge> : `${r.qty} ${r.unit}`}</td>
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

function Expiring({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const q = useQuery({ queryKey: ['expiring', storeId], queryFn: () => api.get<z.infer<typeof ExpiringView>>(`/admin/stores/${storeId}/expiring`) });
  return (
    <>
      <div className="muted">Истёкшие — списать (запрос со сборочного терминала или старшим смены). С малым остатком срока — на уценку: такие партии не резервируются под заказы.</div>
      <ErrorBanner error={q.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Действие</th>
            <th>Товар</th>
            <th>Ячейка</th>
            <th>Количество</th>
            <th>Годен до</th>
            <th>Остаток срока</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.rows ?? []).map((r) => (
            <tr key={r.lot_id}>
              <td>{r.action === 'write_off' ? <Badge tone="red">списать</Badge> : <Badge tone="yellow">уценить</Badge>}</td>
              <td>
                {r.name} <span className="muted">{r.sku}</span>
              </td>
              <td>{r.cell_code ?? '—'}</td>
              <td>{r.qty}</td>
              <td>{dateTime(r.expires_at)}</td>
              <td>{r.left_pct} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data && q.data.rows.length === 0 && <div className="empty">Просроченных и уходящих по сроку партий нет</div>}
    </>
  );
}

function Stocktakes({ storeId }: { storeId: string }) {
  const { api, session } = useStaff();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stocktakes', storeId], queryFn: () => api.get<z.infer<typeof StocktakeListView>>(`/admin/stores/${storeId}/stocktakes`) });
  const [cells, setCells] = useState('');
  const create = useMutation({
    mutationFn: (scope: 'cell' | 'full') => api.post(`/admin/stores/${storeId}/stocktakes`, scope === 'full' ? { scope } : { scope, cell_codes: cells.split(/[,\s]+/).filter(Boolean).map((c) => c.toUpperCase()) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stocktakes', storeId] }),
  });
  const apply = useMutation({
    mutationFn: (id: string) => api.post<{ adjusted: number; unchanged: number; not_counted: number }>(`/admin/stores/${storeId}/stocktakes/${id}/apply`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stocktakes', storeId] }),
  });
  const canApply = session.principal.role === 'manager';
  return (
    <>
      <Card>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          <input className="input" style={{ maxWidth: 360 }} placeholder="ячейки: A-01-1, A-02-1" value={cells} onChange={(e) => setCells(e.target.value)} />
          <Button disabled={!cells || create.isPending} onClick={() => create.mutate('cell')}>
            Пересчёт ячеек
          </Button>
          <Button disabled={create.isPending} onClick={() => create.mutate('full')}>
            Полный круг
          </Button>
        </div>
        <div className="muted">Считают на терминале. Расхождение выше допуска пересчитывает другой сотрудник. Применяет управляющий.</div>
        <ErrorBanner error={create.error ?? apply.error} />
        {apply.data && (
          <div className="banner banner-ok">
            Применено: изменено {apply.data.adjusted}, без изменений {apply.data.unchanged}, не посчитано {apply.data.not_counted}
          </div>
        )}
      </Card>
      {(q.data?.stocktakes ?? []).map((st) => {
        const counted = st.lines.filter((l) => l.qty_fact !== null).length;
        return (
          <Card key={st.id} tone={st.status === 'open' ? 'yellow' : undefined}>
            <div className="row">
              <b>
                {{ daily: 'Выборочная за день', cell: 'Ячейки', full: 'Полный круг' }[st.scope] ?? st.scope} · {dateTime(st.created_at)}
              </b>
              <span>
                <Badge tone={st.status === 'open' ? 'yellow' : 'green'}>{st.status === 'open' ? 'идёт' : 'применена'}</Badge> посчитано {counted}/{st.lines.length}
              </span>
            </div>
            <code className="muted" title="id для терминала">{st.id}</code>
            <table className="table">
              <tbody>
                {st.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.cell_code}</td>
                    <td>{l.name}</td>
                    <td>
                      система {l.qty_system} {l.unit}
                    </td>
                    <td>{l.qty_fact === null ? <span className="muted">не посчитано</span> : `факт ${l.qty_fact} ${l.unit}`}</td>
                    <td>{l.recount_required ? <Badge tone="red">нужен второй пересчёт</Badge> : l.qty_fact !== null && l.qty_fact !== l.qty_system ? <Badge tone="yellow">{l.qty_fact - l.qty_system > 0 ? '+' : ''}{l.qty_fact - l.qty_system}</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {st.status === 'open' && canApply && (
              <Button primary disabled={apply.isPending || counted === 0} onClick={() => apply.mutate(st.id)}>
                Применить расхождения
              </Button>
            )}
          </Card>
        );
      })}
    </>
  );
}
