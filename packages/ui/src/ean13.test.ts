import { describe, expect, it } from 'vitest';
import { ean13Bits } from './ean13.js';

describe('EAN-13 в штрихи', () => {
  it('95 модулей, охранные знаки на месте', () => {
    const b = ean13Bits('4601234567893')!;
    expect(b).toHaveLength(95);
    expect(b.slice(0, 3)).toBe('101');
    expect(b.slice(45, 50)).toBe('01010');
    expect(b.slice(-3)).toBe('101');
  });
  it('не EAN-13 — null', () => expect(ean13Bits('123')).toBeNull());
});
