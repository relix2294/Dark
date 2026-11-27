import { describe, expect, it } from 'vitest';
import { applyModifiers, parseDishModifiers } from './modifiers.js';

const pizza = parseDishModifiers({
  groups: [
    { id: 'size', name: 'Размер', min: 1, max: 1, options: [{ id: '25', name: '25 см' }, { id: '30', name: '30 см', price_dirams: 1500 }] },
    { id: 'add', name: 'Добавки', min: 0, max: 2, options: [{ id: 'cheese', name: 'Сыр', price_dirams: 500 }, { id: 'mush', name: 'Грибы', price_dirams: 400 }, { id: 'hot', name: 'Халапеньо', price_dirams: 300 }] },
  ],
});

describe('модификаторы блюд', () => {
  it('доплата и снимок', () => {
    expect(applyModifiers(pizza, { size: ['30'], add: ['cheese', 'mush'] })).toEqual({
      extra: 2400,
      snapshot: [
        { group: 'Размер', options: [{ name: '30 см', price_dirams: 1500 }] },
        { group: 'Добавки', options: [{ name: 'Сыр', price_dirams: 500 }, { name: 'Грибы', price_dirams: 400 }] },
      ],
    });
  });
  it('обязательная группа', () => expect(applyModifiers(pizza, {})).toMatchObject({ error: expect.stringContaining('минимум 1') }));
  it('больше максимума', () => expect(applyModifiers(pizza, { size: ['25'], add: ['cheese', 'mush', 'hot'] })).toMatchObject({ error: expect.stringContaining('максимум 2') }));
  it('чужие id и повторы', () => {
    expect(applyModifiers(pizza, { size: ['40'] })).toHaveProperty('error');
    expect(applyModifiers(pizza, { size: ['25'], x: ['1'] })).toHaveProperty('error');
    expect(applyModifiers(pizza, { size: ['25'], add: ['cheese', 'cheese'] })).toHaveProperty('error');
  });
  it('старые данные {} — без модификаторов', () => {
    expect(parseDishModifiers({})).toEqual({ groups: [] });
    expect(applyModifiers(parseDishModifiers({}), undefined)).toEqual({ extra: 0, snapshot: [] });
  });
  it('невалидное определение группы отвергается', () => {
    expect(parseDishModifiers({ groups: [{ id: 'g', name: 'g', min: 2, max: 1, options: [{ id: 'a', name: 'a' }] }] })).toEqual({ groups: [] });
  });
});
