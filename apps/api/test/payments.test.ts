import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { nightlyReconcile, releaseOrphanHolds, warnExpiringHolds } from '../src/modules/payments/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
});
afterAll(async () => ctx.close());

const order = async () => {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/orders',
    payload: { brand: 'LAB', store_id: w.store.id, address_id: w.addr.id, items: [{ product_id: w.p1.id, qty: 2 }], expected_total_dirams: 3500 },
    headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': randomUUID() },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};

describe('страховки по деньгам (ТЗ §5)', () => {
  it('холд у отменённого заказа снимается сверкой', async () => {
    const id = await order();
    // сбой банка при отмене: заказ отменён, холд остался
    await ctx.deps.db.update(s.order).set({ status: 'cancelled' }).where(eq(s.order.id, id));
    expect(await releaseOrphanHolds(ctx.deps)).toEqual([id]);
    const [p] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, id));
    expect(p!.status).toBe('released');
    expect(await releaseOrphanHolds(ctx.deps)).toEqual([]);
  });

  it('истекающий холд у активного заказа — одна тревога за 10 минут', async () => {
    const id = await order();
    await ctx.deps.db.update(s.payment).set({ holdExpiresAt: new Date(ctx.deps.clock.now().getTime() + 5 * 60_000) }).where(eq(s.payment.orderId, id));
    expect(await warnExpiringHolds(ctx.deps)).toBe(1);
    expect(await warnExpiringHolds(ctx.deps)).toBe(0);
    const ev = await ctx.deps.db.select().from(s.outbox).where(eq(s.outbox.topic, 'payment.hold_expiring'));
    expect(ev[0]!.payload).toMatchObject({ order_id: id, store_id: w.store.id });
  });

  it('ночная сверка: списание есть у нас, у банка его нет — расхождение', async () => {
    const id = await order();
    const [p] = await ctx.deps.db.select().from(s.payment).where(eq(s.payment.orderId, id));
    // у нас списано, банк (заглушка) считает холд
    await ctx.deps.db.update(s.payment).set({ status: 'captured', capturedDirams: 3500 }).where(eq(s.payment.id, p!.id));
    await ctx.deps.db.insert(s.paymentOp).values({ paymentId: p!.id, type: 'capture', amountDirams: 3500, idempotencyKey: `${id}:capture:1`, status: 'ok' });
    const r = await nightlyReconcile(ctx.deps, new Date(Date.now() + 3600_000));
    expect(r.mismatches).toEqual([{ payment_id: p!.id, expected: 'captured', bank: 'held' }]);
    const ev = await ctx.deps.db.select().from(s.outbox).where(eq(s.outbox.topic, 'payment.reconcile_mismatch'));
    expect(ev).toHaveLength(1);
  });
});
