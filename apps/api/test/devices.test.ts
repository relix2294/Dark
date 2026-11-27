import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';
import { detectOfflineDevices } from '../src/modules/backoffice/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let picker: string;
let cook: string;
let lead: string;
const T0 = new Date('2026-11-27T07:00:00Z'); // пятница 12:00 Душанбе, точка открыта
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const mk = async (phone: string, name: string, role: 'picker' | 'cook' | 'shift_lead') => {
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone, name, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token;
  };
  picker = await mk('+992900000041', 'Али', 'picker');
  cook = await mk('+992900000042', 'Зафар', 'cook');
  lead = await mk('+992900000044', 'Нигора', 'shift_lead');
});
afterAll(async () => ctx.close());

// пульс — без Idempotency-Key: устройство шлёт его раз в 30 с
const beat = (token: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/staff/heartbeat', payload: body, headers: { authorization: `Bearer ${token}` } });
const devices = async () => (await ctx.app.inject({ method: 'GET', url: `/api/v1/console/stores/${w.store.id}/devices`, headers: { authorization: `Bearer ${lead}` } })).json().devices;
const offlineEvents = () => ctx.deps.db.select().from(s.outbox).where(eq(s.outbox.topic, 'device.offline'));

describe('связь устройств точки (ТЗ §10)', () => {
  it('молчит больше 2 минут в рабочее время → одна тревога на эпизод; пульс открывает новый эпизод', async () => {
    ctx.setNow(T0);
    expect((await beat(picker, { device_id: 'term-0001', app: 'picker' })).statusCode).toBe(204);
    expect((await beat(cook, { device_id: 'kds-0001', app: 'kds' })).statusCode).toBe(204);

    ctx.setNow(at(1));
    expect(await detectOfflineDevices(ctx.deps)).toBe(0);
    expect(await devices()).toEqual([
      expect.objectContaining({ device_id: 'term-0001', app: 'picker', staff_name: 'Али', online: true }),
      expect.objectContaining({ device_id: 'kds-0001', app: 'kds', staff_name: 'Зафар', online: true }),
    ]);

    // кухня продолжает слать пульс, терминал замолчал
    ctx.setNow(at(2.5));
    await beat(cook, { device_id: 'kds-0001', app: 'kds' });
    ctx.setNow(at(3));
    expect(await detectOfflineDevices(ctx.deps)).toBe(1);
    expect(await detectOfflineDevices(ctx.deps)).toBe(0);
    const ev = await offlineEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ store_id: w.store.id, app: 'picker', staff_name: 'Али' });
    expect((await devices()).find((d: { app: string }) => d.app === 'picker').online).toBe(false);

    const alerts = (await ctx.app.inject({ method: 'GET', url: `/api/v1/console/stores/${w.store.id}/alerts`, headers: { authorization: `Bearer ${lead}` } })).json().alerts;
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'device.offline', level: 'critical', text: 'Терминал сборщика (Али) не на связи с 12:00' })]));

    // связь вернулась и снова пропала — новая тревога
    ctx.setNow(at(4));
    await beat(picker, { device_id: 'term-0001', app: 'picker' });
    await beat(cook, { device_id: 'kds-0001', app: 'kds' });
    ctx.setNow(at(7));
    expect(await detectOfflineDevices(ctx.deps)).toBe(2);
  });

  it('штатный выход и нерабочее время — без тревоги; чужая роль без точки — игнор', async () => {
    ctx.setNow(at(10));
    await beat(picker, { device_id: 'term-0001', app: 'picker', bye: true });
    await beat(cook, { device_id: 'kds-0001', app: 'kds' });
    // 23:05 Душанбе — точка закрыта (часы 08:00–23:00)
    ctx.setNow(new Date('2026-11-27T18:05:00Z'));
    const before = (await offlineEvents()).length;
    expect(await detectOfflineDevices(ctx.deps)).toBe(0);
    expect((await offlineEvents()).length).toBe(before);
    expect((await devices()).map((d: { device_id: string }) => d.device_id)).toEqual(['kds-0001']);

    // клиенту пульс недоступен
    expect((await beat(w.token, { device_id: 'phone-0001', app: 'picker' })).statusCode).toBe(403);
    expect((await beat(picker, { device_id: 'x', app: 'picker' })).statusCode).toBe(400);
  });
});
