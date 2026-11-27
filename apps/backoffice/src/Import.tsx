import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Brand, ImportResult } from '@dark/contracts';
import { BRAND_RU, Badge, Button, Card, ErrorBanner, Field, useStaff } from '@dark/ui';
import { parseCsv, toImportRows } from './csv.js';

type Result = z.infer<typeof ImportResult>;

/** Импорт каталога из CSV: загрузка → проверка (без записи) → применение одной транзакцией. */
export function Import({ storeId }: { storeId: string }) {
  const { api } = useStaff();
  const [brand, setBrand] = useState<Brand>('LAB');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [file, setFile] = useState('');
  const [reason, setReason] = useState('загрузка каталога');
  const [res, setRes] = useState<Result | null>(null);
  const send = useMutation({
    mutationFn: (dry_run: boolean) => api.post<Result>('/admin/products/import', { brand, store_id: storeId, rows, dry_run, reason }),
    onSuccess: setRes,
  });

  const onFile = async (f: File) => {
    const text = await f.text();
    const r = toImportRows(parseCsv(text));
    setRows(r.rows);
    setUnknown(r.unknownHeaders);
    setFile(f.name);
    setRes(null);
  };

  return (
    <>
      <Card>
        <h2>Импорт каталога из CSV</h2>
        <div className="muted">
          Колонки: артикул, название, категория, штрихкоды (через | или ;), цена (сомони), зона (обычная/холод/заморозка), весовой (да/нет),
          срок годности, активен. Ключ — бренд + артикул: есть — обновляется, нет — создаётся. Цена ставится на выбранную точку.
        </div>
        <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          <div className="tabs">
            {(['LAB', 'SOR'] as Brand[]).map((b) => (
              <button key={b} className={`tab${brand === b ? ' tab-active' : ''}`} onClick={() => { setBrand(b); setRes(null); }}>
                {BRAND_RU[b]}
              </button>
            ))}
          </div>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
        {file && (
          <div>
            Файл <b>{file}</b>: {rows.length} строк
            {unknown.length > 0 && <span className="muted"> · пропущены колонки: {unknown.join(', ')}</span>}
          </div>
        )}
        <Field label="Причина (в журнал)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBanner error={send.error} />
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <Button disabled={!rows.length || send.isPending} onClick={() => send.mutate(true)}>
            Проверить
          </Button>
          <Button primary disabled={!res || res.errors.length > 0 || res.applied || !res.dry_run || send.isPending} onClick={() => send.mutate(false)}>
            Применить
          </Button>
        </div>
      </Card>
      {res && (
        <Card tone={res.errors.length ? 'red' : res.applied ? 'green' : 'yellow'}>
          <h2>{res.applied ? 'Импорт применён' : res.errors.length ? 'Есть ошибки — ничего не записано' : 'Проверка пройдена — можно применять'}</h2>
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <Badge tone="green">новых: {res.created}</Badge>
            <Badge tone="blue">обновится: {res.updated}</Badge>
            <Badge tone="yellow">цен изменится: {res.prices_changed}</Badge>
            {res.categories_created.length > 0 && <Badge>новые категории: {res.categories_created.join(', ')}</Badge>}
          </div>
          {res.errors.slice(0, 200).map((e, i) => (
            <div key={i} className="row">
              <span className="muted">строка {e.row}</span>
              <span>{e.message}</span>
            </div>
          ))}
          {res.errors.length > 200 && <div className="muted">… и ещё {res.errors.length - 200}</div>}
        </Card>
      )}
    </>
  );
}
