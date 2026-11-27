import { describe, expect, it } from 'vitest';
import { parseCsv, toImportRows } from './csv.js';

describe('CSV каталога', () => {
  it('Excel: BOM, точка с запятой, кавычки, перевод строки в ячейке', () => {
    const t = parseCsv('﻿Артикул;Название;Цена\r\nA-1;"Сок ""Добрый"" 1 л";12,50\r\nA-2;"Хлеб\nбелый";8\r\n');
    expect(t).toEqual([
      ['Артикул', 'Название', 'Цена'],
      ['A-1', 'Сок "Добрый" 1 л', '12,50'],
      ['A-2', 'Хлеб\nбелый', '8'],
    ]);
  });
  it('запятая как разделитель, пустые строки пропускаются', () => {
    expect(parseCsv('sku,name\n\nX,Y\n')).toEqual([['sku', 'name'], ['X', 'Y']]);
  });
  it('строки импорта: деньги в дирамах, штрихкоды списком, зона и флаги по-русски', () => {
    const { rows, unknownHeaders } = toImportRows(
      parseCsv('артикул;название;штрихкоды;цена;зона;весовой;лишнее\nB-1;Бананы;460001|460002;22,9;обычная;да;x\nB-2;Молоко;;11;холод;нет;'),
    );
    expect(unknownHeaders).toEqual(['лишнее']);
    expect(rows[0]).toEqual({ sku: 'B-1', name_ru: 'Бананы', barcodes: ['460001', '460002'], price_dirams: 2290, temp_zone: 'ambient', is_weighted: true });
    expect(rows[1]).toEqual({ sku: 'B-2', name_ru: 'Молоко', price_dirams: 1100, temp_zone: 'chill', is_weighted: false });
  });
  it('неверные значения передаются как есть — сервер покажет ошибку в строке', () => {
    const { rows } = toImportRows(parseCsv('sku;name;price\nX;Y;дорого'));
    expect(rows[0]!['price_dirams']).toBe('дорого');
  });
});
