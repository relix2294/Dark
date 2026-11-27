/**
 * Разбор CSV каталога в строки импорта. Принимает выгрузку из Excel/1С: BOM, разделитель «;» или «,»,
 * кавычки с удвоением, переводы строк внутри кавычек. Заголовки — по-русски или по-английски.
 * Деньги: «12,50» или «12.50» сомони → 1250 дирам; целые дирамы считаются только здесь, не на сервере.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<string, string> = {
  sku: 'sku', артикул: 'sku',
  name: 'name_ru', name_ru: 'name_ru', название: 'name_ru', наименование: 'name_ru',
  name_tj: 'name_tj', 'название тадж': 'name_tj',
  category: 'category', категория: 'category',
  barcode: 'barcodes', barcodes: 'barcodes', штрихкод: 'barcodes', штрихкоды: 'barcodes',
  unit: 'unit', ед: 'unit', единица: 'unit',
  temp_zone: 'temp_zone', зона: 'temp_zone', температура: 'temp_zone',
  weighted: 'is_weighted', is_weighted: 'is_weighted', весовой: 'is_weighted',
  high_value: 'is_high_value', is_high_value: 'is_high_value', дорогой: 'is_high_value',
  shelf_life_days: 'shelf_life_days', 'срок годности': 'shelf_life_days', срок: 'shelf_life_days',
  price: 'price', цена: 'price',
  active: 'is_active', is_active: 'is_active', активен: 'is_active',
};

const TEMP: Record<string, string> = { ambient: 'ambient', обычная: 'ambient', chill: 'chill', холод: 'chill', охлаждённая: 'chill', охлажденная: 'chill', frozen: 'frozen', заморозка: 'frozen' };
const bool = (v: string) => /^(1|да|yes|true|y|д)$/i.test(v.trim());

export function toImportRows(table: string[][]): { rows: Record<string, unknown>[]; unknownHeaders: string[] } {
  const [head, ...body] = table;
  if (!head) return { rows: [], unknownHeaders: [] };
  const keys = head.map((h) => HEADERS[h.trim().toLowerCase()] ?? null);
  const unknownHeaders = head.filter((_, i) => keys[i] === null).map((h) => h.trim()).filter(Boolean);
  const rows = body.map((cells) => {
    const r: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const v = (cells[i] ?? '').trim();
      if (!k || v === '') return;
      switch (k) {
        case 'barcodes':
          r[k] = v.split(/[|;,\s]+/).filter(Boolean);
          break;
        case 'price': {
          const n = Number(v.replace(/\s/g, '').replace(',', '.'));
          r['price_dirams'] = Number.isFinite(n) ? Math.round(n * 100) : v;
          break;
        }
        case 'temp_zone':
          r[k] = TEMP[v.toLowerCase()] ?? v;
          break;
        case 'is_weighted':
        case 'is_high_value':
        case 'is_active':
          r[k] = bool(v);
          break;
        case 'shelf_life_days':
          r[k] = /^\d+$/.test(v) ? Number(v) : v;
          break;
        default:
          r[k] = v;
      }
    });
    return r;
  });
  return { rows, unknownHeaders };
}
