import { describe, expect, it } from 'vitest';
import { ean13CheckDigit, internalEan13, isValidEan13 } from './barcode.js';

describe('EAN-13', () => {
  it('контрольная цифра известного кода', () => {
    expect(ean13CheckDigit('460123456789')).toBe(3); // 4601234567893
    expect(isValidEan13('4601234567893')).toBe(true);
    expect(isValidEan13('4601234567890')).toBe(false);
  });
  it('внутренний код: префикс 200 и валидная контрольная', () => {
    const c = internalEan13(42);
    expect(c).toMatch(/^200000000042\d$/);
    expect(isValidEan13(c)).toBe(true);
  });
});
