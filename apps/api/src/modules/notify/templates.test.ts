import { describe, expect, it } from 'vitest';
import { render } from './templates.js';

const at = new Date('2026-11-27T09:35:00Z'); // 14:35 Душанбе

describe('тексты уведомлений (ТЗ §10)', () => {
  it('заказ принят — номер и время по Душанбе', () => {
    expect(render.accepted({ number: 'L-000123', brand: 'LAB', promisedAt: at })).toEqual({ title: 'Lablabu: заказ L-000123 принят', body: 'Доставим к 14:35.' });
  });
  it('замена и нет товара — с новой суммой', () => {
    expect(render.itemChanged({ number: 'L-1', totalDirams: 4550 }, { name: 'Сыр гауда', status: 'replaced', replacement: 'Сыр эдам' }).body).toBe('«Сыр гауда» заменили на «Сыр эдам». Новая сумма 45.50 с.');
    expect(render.itemChanged({ number: 'L-1', totalDirams: 3000 }, { name: 'Молоко', status: 'missing' }).title).toBe('Заказ L-1: товара нет');
  });
  it('курьер выехал — имя и ссылка', () => {
    expect(render.courierLeft({ number: 'S-7', promisedAt: at }, 'Фируз', 'https://x/o/1').body).toBe('Курьер Фируз выехал, будет к 14:35. Где он: https://x/o/1');
  });
  it('отмена: с удержанием и без', () => {
    expect(render.cancelled({ number: 'S-7', cancelReason: 'клиент передумал', capturedDirams: 6500 }).body).toBe('Причина: клиент передумал. Удержано 65.00 с за уже приготовленное.');
    expect(render.cancelled({ number: 'L-2', cancelReason: null, capturedDirams: 0 }).body).toBe('Деньги не списаны, блокировка на карте снята.');
  });
});
