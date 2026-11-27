import { describe, expect, it } from 'vitest';
import { TokenService, hasPermission, hashPin, requireStaff, verifyPin } from './index.js';

describe('auth', () => {
  it('PIN hash/verify', () => {
    const h = hashPin('1234');
    expect(verifyPin('1234', h)).toBe(true);
    expect(verifyPin('1235', h)).toBe(false);
  });
  it('JWT round-trip', async () => {
    const ts = new TokenService('x'.repeat(32));
    const { token } = await ts.sign({ kind: 'staff', staff_id: '3f0c5d48-5b0a-4e5a-9c7a-1f2e3d4c5b6a', role: 'picker', store_id: null });
    const p = await ts.verify(token);
    expect(p).toMatchObject({ kind: 'staff', role: 'picker' });
    await expect(ts.verify(token + 'x')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('матрица прав (ТЗ §9)', () => {
    expect(hasPermission('picker', 'wms.pick')).toBe(true);
    expect(hasPermission('picker', 'catalog.write')).toBe(false);
    expect(hasPermission('finance', 'payments.refund.over_limit')).toBe(true);
    expect(hasPermission('shift_lead', 'payments.refund.over_limit')).toBe(false);
    expect(hasPermission('manager', 'wms.stock.adjust')).toBe(true);
  });
  it('сотрудник не видит чужую точку', () => {
    const p = { kind: 'staff' as const, staff_id: 'a', role: 'picker' as const, store_id: 's1' };
    expect(() => requireStaff(p, 'wms.pick', 's2')).toThrow(/Чужая точка/);
    expect(requireStaff(p, 'wms.pick', 's1')).toBe(p);
  });
});
