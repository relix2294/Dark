import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

/** Защита PIN персонала от перебора. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let adminTok: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000801', name: 'Сборщик', role: 'picker', storeId: w.store.id, pinHash: hashPin('1234') });
  const [a] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900000809', name: 'Админ', role: 'admin', storeId: null, pinHash: hashPin('9999') }).returning();
  adminTok = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: a!.id, role: 'admin', store_id: null })).token;
});
afterAll(async () => ctx.close());

const login = (phone: string, pin: string, ip = '10.0.0.1') =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/staff', payload: { phone, pin }, remoteAddress: ip });

describe('вход по PIN', () => {
  it('5 неверных PIN — блокировка, даже верный PIN не пускает; журнал', async () => {
    for (let i = 0; i < 5; i++) expect((await login('+992900000801', '0000')).statusCode).toBe(401);
    const locked = await login('+992900000801', '1234');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    const log = await ctx.deps.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'auth.locked'));
    expect(log).toHaveLength(1);
  });

  it('через 15 минут снова можно; успешный вход сбрасывает счётчик', async () => {
    ctx.setNow(new Date(ctx.deps.clock.now().getTime() + 16 * 60_000));
    expect((await login('+992900000801', '1234')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await login('+992900000801', '0000');
    expect((await login('+992900000801', '1234')).statusCode).toBe(200); // 4 неудачи + успех — без блокировки
    ctx.setNow(new Date('2026-11-27T07:00:00Z'));
  });

  it('смена PIN админом снимает блокировку', async () => {
    for (let i = 0; i < 5; i++) await login('+992900000801', '1111', '10.0.0.2');
    expect((await login('+992900000801', '1234', '10.0.0.2')).statusCode).toBe(429);
    const [u] = await ctx.deps.db.select().from(s.userStaff).where(eq(s.userStaff.phone, '+992900000801'));
    const p = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/staff/${u!.id}`,
      payload: { pin: '4321', reason: 'забыл PIN' },
      headers: { authorization: `Bearer ${adminTok}`, 'idempotency-key': randomUUID() },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect((await login('+992900000801', '4321', '10.0.0.2')).statusCode).toBe(200);
  });

  it('перебор по многим телефонам с одного IP — блокируется адрес', async () => {
    for (let i = 0; i < 20; i++) await login(`+99299000${String(i).padStart(4, '0')}`, '0000', '10.0.0.66');
    expect((await login('+992900000809', '9999', '10.0.0.66')).statusCode).toBe(429);
    expect((await login('+992900000809', '9999', '10.0.0.77')).statusCode).toBe(200);
  });
});
