import { describe, expect, it } from 'vitest';
import { StubWalletAdapter } from './stub-adapter.js';

const clock = { now: () => new Date('2026-11-27T10:00:00Z') };

describe('StubWalletAdapter', () => {
  it('hold → capture частичный, повтор по тому же ключу не создаёт второго движения', async () => {
    const w = new StubWalletAdapter(clock);
    const h = await w.hold({ dcUserId: 'u1', amount: 11000, orderNumber: 'L-1', idempotencyKey: 'o1:hold:1' });
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    const c1 = await w.capture({ providerRef: h.providerRef, amount: 10500, idempotencyKey: 'o1:capture:1' });
    const c2 = await w.capture({ providerRef: h.providerRef, amount: 10500, idempotencyKey: 'o1:capture:1' });
    expect(c1).toEqual(c2);
    expect(await w.status(h.providerRef)).toBe('captured');
    const again = await w.capture({ providerRef: h.providerRef, amount: 1, idempotencyKey: 'o1:capture:2' });
    expect(again.ok).toBe(false);
  });
  it('capture больше холда отклоняется', async () => {
    const w = new StubWalletAdapter(clock);
    const h = await w.hold({ dcUserId: 'u1', amount: 100, orderNumber: 'L-1', idempotencyKey: 'k1' });
    if (!h.ok) throw new Error();
    expect((await w.capture({ providerRef: h.providerRef, amount: 101, idempotencyKey: 'k2' })).ok).toBe(false);
  });
  it('отказ и таймаут по суффиксу', async () => {
    const w = new StubWalletAdapter(clock);
    expect(await w.hold({ dcUserId: 'u-declined', amount: 1, orderNumber: 'x', idempotencyKey: 'a' })).toMatchObject({ ok: false, reason: 'declined' });
    expect(await w.hold({ dcUserId: 'u-timeout', amount: 1, orderNumber: 'x', idempotencyKey: 'b' })).toMatchObject({ ok: false, reason: 'timeout' });
  });
});
