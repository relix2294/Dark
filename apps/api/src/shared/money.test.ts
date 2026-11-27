import { describe, expect, it } from 'vitest';
import { holdAmount, lineTotal, orderTotal, percentOf, toSomoni } from './money.js';

describe('money (дирамы)', () => {
  it('штучный товар: qty × price', () => expect(lineTotal(1250, 3)).toBe(3750));
  it('весовой товар: цена за кг, qty в граммах, округление', () => {
    expect(lineTotal(2999, 333, true)).toBe(999); // 2999 * 0.333 = 998.667
  });
  it('процент округляется до дирама', () => expect(percentOf(11500, 10)).toBe(1150));
  it('total = items + fee − discount', () => expect(orderTotal(10000, 1500, 500)).toBe(11000));
  it('скидка больше базы — ошибка', () => expect(() => orderTotal(100, 0, 200)).toThrow(RangeError));
  it('холд с буфером только для весового', () => {
    expect(holdAmount(10000, true, 10)).toBe(11000);
    expect(holdAmount(10000, false, 10)).toBe(10000);
  });
  it('float в деньгах запрещён', () => expect(() => lineTotal(12.5, 1)).toThrow(TypeError));
  it('форматирование в сомони', () => expect(toSomoni(11505)).toBe('115.05'));
});
