import { describe, expect, it } from 'vitest';
import { selectionFromSnapshot } from './feedback.js';

const def = {
  groups: [
    { id: 'size', name: 'Размер', min: 1, max: 1, options: [{ id: 's25', name: '25 см', price_dirams: 0 }, { id: 's30', name: '30 см', price_dirams: 500 }] },
    { id: 'add', name: 'Добавки', min: 0, max: 2, options: [{ id: 'cheese', name: 'Сыр', price_dirams: 300 }] },
  ],
};

describe('снимок модификаторов → выбор по текущему меню', () => {
  it('по названиям группы и варианта', () => {
    expect(selectionFromSnapshot(def, [{ group: 'Размер', options: [{ name: '30 см', price_dirams: 400 }] }, { group: 'Добавки', options: [{ name: 'Сыр', price_dirams: 300 }] }])).toEqual({ size: ['s30'], add: ['cheese'] });
    expect(selectionFromSnapshot(def, [])).toEqual({});
  });
  it('варианта или группы больше нет → null', () => {
    expect(selectionFromSnapshot(def, [{ group: 'Размер', options: [{ name: '40 см', price_dirams: 0 }] }])).toBeNull();
    expect(selectionFromSnapshot(def, [{ group: 'Соус', options: [{ name: 'Чесночный', price_dirams: 0 }] }])).toBeNull();
  });
});
