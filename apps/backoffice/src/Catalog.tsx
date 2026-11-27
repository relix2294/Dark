import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Brand, CategoryListView, ProductListView, ProductView } from '@dark/contracts';
import { BRAND_RU, Badge, Button, Card, ErrorBanner, Field, somoni, useStaff } from '@dark/ui';

type Product = z.infer<typeof ProductView>;

/** Каталог: поиск по названию, артикулу и штрихкоду; карточка товара; цена на точке с причиной (в журнал). */
export function Catalog({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const [brand, setBrand] = useState<Brand>('LAB');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Product | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['admin-products', brand, q],
    queryFn: () => api.get<z.infer<typeof ProductListView>>(`/admin/products?brand=${brand}&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  const cats = useQuery({ queryKey: ['admin-cats', brand], queryFn: () => api.get<z.infer<typeof CategoryListView>>(`/admin/categories?brand=${brand}`) });
  const catName = (id: string | null) => cats.data?.categories.find((c) => c.id === id)?.name ?? '—';

  return (
    <>
      <div className="row">
        <div className="tabs">
          {(['LAB', 'SOR'] as Brand[]).map((b) => (
            <button key={b} className={`tab${brand === b ? ' tab-active' : ''}`} onClick={() => setBrand(b)}>
              {BRAND_RU[b]}
            </button>
          ))}
        </div>
        <input className="input" style={{ maxWidth: 360 }} placeholder="Название, артикул или штрихкод" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button primary onClick={() => setEdit('new')}>
          + Товар
        </Button>
      </div>
      <ErrorBanner error={list.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Артикул</th>
            <th>Название</th>
            <th>Категория</th>
            <th>Цена на точке</th>
            <th>Зона</th>
            <th>Штрихкоды</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data?.products ?? []).map((p) => {
            const pr = p.prices.find((x) => x.store_id === storeId);
            return (
              <tr key={p.id} className="row-click" onClick={() => setEdit(p)}>
                <td>
                  <code>{p.sku}</code>
                </td>
                <td>
                  {p.name_ru} {!p.is_active && <Badge tone="red">скрыт</Badge>} {p.is_high_value && <Badge tone="yellow">дорогой</Badge>} {p.dish && <Badge tone="blue">{p.dish.station}</Badge>}
                </td>
                <td className="muted">{catName(p.category_id)}</td>
                <td>
                  {pr ? somoni(pr.price_dirams) : <Badge tone="red">нет цены</Badge>}
                  {pr?.old_price_dirams ? <span className="muted"> (было {somoni(pr.old_price_dirams)})</span> : null}
                </td>
                <td className="muted">{p.temp_zone}</td>
                <td className="muted">{p.barcodes.join(', ')}</td>
                <td />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted">Всего: {list.data?.total ?? 0}</div>
      {edit && (
        <ProductEditor
          storeId={storeId}
          brand={brand}
          product={edit === 'new' ? null : edit}
          categories={cats.data?.categories ?? []}
          onClose={() => {
            setEdit(null);
            void qc.invalidateQueries({ queryKey: ['admin-products'] });
          }}
        />
      )}
    </>
  );
}

function ProductEditor({ storeId, brand, product, categories, onClose }: { storeId: string; brand: Brand; product: Product | null; categories: { id: string; name: string }[]; onClose: () => void }) {
  const { api } = useStaff();
  const [f, setF] = useState({
    sku: product?.sku ?? '',
    name_ru: product?.name_ru ?? '',
    category_id: product?.category_id ?? '',
    barcodes: product?.barcodes.join(', ') ?? '',
    temp_zone: product?.temp_zone ?? 'ambient',
    is_weighted: product?.is_weighted ?? false,
    is_high_value: product?.is_high_value ?? false,
    is_active: product?.is_active ?? true,
    shelf_life_days: product?.shelf_life_days?.toString() ?? '',
  });
  const cur = product?.prices.find((p) => p.store_id === storeId);
  const [price, setPrice] = useState(cur ? String(cur.price_dirams / 100) : '');
  const [reason, setReason] = useState('');
  const [newCat, setNewCat] = useState('');
  const body = {
    sku: f.sku,
    name_ru: f.name_ru,
    category_id: f.category_id || null,
    barcodes: f.barcodes.split(/[,\s]+/).filter(Boolean),
    temp_zone: f.temp_zone,
    is_weighted: f.is_weighted,
    is_high_value: f.is_high_value,
    is_active: f.is_active,
    shelf_life_days: f.shelf_life_days ? Number(f.shelf_life_days) : null,
    unit: f.is_weighted ? 'г' : 'шт',
  };
  const save = useMutation({
    mutationFn: async () => {
      const p = product ? await api.patch<Product>(`/admin/products/${product.id}`, body) : await api.post<Product>('/admin/products', { ...body, brand });
      const dirams = Math.round(Number(price.replace(',', '.')) * 100);
      if (price && dirams !== cur?.price_dirams) {
        await api.put(`/admin/products/${p.id}/price`, { store_id: storeId, price_dirams: dirams, old_price_dirams: cur && dirams < cur.price_dirams ? cur.price_dirams : null, reason: reason || 'изменение цены' });
      }
    },
    onSuccess: onClose,
  });
  const addCat = useMutation({ mutationFn: () => api.post<{ id: string }>('/admin/categories', { brand, name: newCat }), onSuccess: (c) => setF({ ...f, category_id: c.id }) });

  return (
    <div className="modal">
      <Card>
        <div className="row">
          <h2>{product ? product.name_ru : 'Новый товар'}</h2>
          <Button onClick={onClose}>✕</Button>
        </div>
        <ErrorBanner error={save.error ?? addCat.error} />
        <div className="grid">
          <Field label="Артикул">
            <input className="input" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} disabled={!!product} />
          </Field>
          <Field label="Название (рус.)">
            <input className="input" value={f.name_ru} onChange={(e) => setF({ ...f, name_ru: e.target.value })} />
          </Field>
          <Field label="Категория">
            <select className="input" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Новая категория">
            <div className="row">
              <input className="input" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
              <Button disabled={!newCat} onClick={() => addCat.mutate()}>
                +
              </Button>
            </div>
          </Field>
          <Field label="Штрихкоды (через запятую)">
            <input className="input" value={f.barcodes} onChange={(e) => setF({ ...f, barcodes: e.target.value })} />
          </Field>
          <Field label="Температурная зона">
            <select className="input" value={f.temp_zone} onChange={(e) => setF({ ...f, temp_zone: e.target.value as typeof f.temp_zone })}>
              <option value="ambient">обычная</option>
              <option value="chill">охлаждённая</option>
              <option value="frozen">заморозка</option>
            </select>
          </Field>
          <Field label="Срок годности, дней">
            <input className="input" inputMode="numeric" value={f.shelf_life_days} onChange={(e) => setF({ ...f, shelf_life_days: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label={`Цена на точке, сомони${f.is_weighted ? ' за кг' : ''}`}>
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Причина изменения цены">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="в журнал" />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {(
            [
              ['is_weighted', 'весовой'],
              ['is_high_value', 'дорогой (только под камеру)'],
              ['is_active', 'показывать'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
        <Button primary disabled={!f.sku || !f.name_ru || save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </Button>
      </Card>
    </div>
  );
}
