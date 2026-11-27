import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { z } from 'zod';
import type { PlaceSuggestion, StockLotView } from '@dark/contracts';
import { Button, Card, ErrorBanner, Field, NumPad, useBarcodeScanner, useStaff } from '@dark/ui';

type Lot = z.infer<typeof StockLotView>;
type Suggestion = z.infer<typeof PlaceSuggestion>;

/** Приёмка по документу поставки и размещение в ячейку с подсказкой системы (ТЗ §7). */
export function Receiving() {
  const { api } = useStaff();
  const [supplyId, setSupplyId] = useState(localStorage.getItem('dark.picker.supply') ?? '');
  const [barcode, setBarcode] = useState('');
  const [qty, setQty] = useState('1');
  const [expires, setExpires] = useState('');
  const [lot, setLot] = useState<Lot | null>(null);
  const [suggest, setSuggest] = useState<Suggestion | null>(null);
  const [cell, setCell] = useState('');
  const [error, setError] = useState<unknown>(null);

  const receive = useMutation({
    mutationFn: () => api.post<Lot>(`/wms/supplies/${supplyId}/receive`, { barcode, qty: Number(qty), ...(expires ? { expires_at: expires } : {}) }),
    onSuccess: async (l) => {
      setLot(l);
      setError(null);
      setSuggest(await api.get<Suggestion>(`/wms/lots/${l.lot_id}/suggest`));
    },
    onError: setError,
  });
  const place = useMutation({
    mutationFn: () => api.post<Lot>('/wms/place', { lot_id: lot!.lot_id, cell_code: cell, qty: lot!.qty }),
    onSuccess: () => {
      setLot(null);
      setSuggest(null);
      setBarcode('');
      setQty('1');
      setCell('');
      setError(null);
    },
    onError: setError,
  });

  useBarcodeScanner(
    useCallback(
      (code: string) => {
        if (lot) setCell(code.toUpperCase());
        else setBarcode(code);
      },
      [lot],
    ),
  );

  return (
    <>
      <Field label="Поставка (id документа)">
        <input className="input" value={supplyId} onChange={(e) => { setSupplyId(e.target.value); localStorage.setItem('dark.picker.supply', e.target.value); }} />
      </Field>
      <ErrorBanner error={error} />
      {!lot ? (
        <Card>
          <Field label="Штрихкод (сканер или ввод)">
            <input className="input" value={barcode} onChange={(e) => setBarcode(e.target.value)} data-scanner="1" />
          </Field>
          <Field label="Срок годности (необязательно)">
            <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <div className="muted">Количество</div>
          <div className="big">{qty || '0'}</div>
          <NumPad value={qty} onChange={setQty} onEnter={() => receive.mutate()} />
        </Card>
      ) : (
        <Card tone="yellow">
          <h2>Партия принята: {lot.qty} ед.</h2>
          <div className="muted">Система предлагает ячейки (лучшая первая):</div>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
            {(suggest?.suggested ?? []).map((c) => (
              <Button key={c.cell_code} primary={cell === c.cell_code} onClick={() => setCell(c.cell_code)}>
                {c.cell_code} <span className="muted">({c.free_units} св.)</span>
              </Button>
            ))}
          </div>
          <Field label="Ячейка (скан или выбор)">
            <input className="input" value={cell} onChange={(e) => setCell(e.target.value.toUpperCase())} data-scanner="1" />
          </Field>
          <Button big primary disabled={!cell || place.isPending} onClick={() => place.mutate()}>
            Разместить
          </Button>
          <Button onClick={() => { setLot(null); setSuggest(null); }}>Оставить без ячейки</Button>
        </Card>
      )}
    </>
  );
}
