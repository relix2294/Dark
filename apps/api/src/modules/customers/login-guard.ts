import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../shared/db/client.js';
import { authAttempt } from '../../shared/db/schema/index.js';

/**
 * Защита PIN от перебора. PIN персонала — 4–6 цифр: без ограничения 10 000 вариантов перебираются за минуты.
 * - телефон: PHONE_MAX неудач за окно → блокировка входа по этому телефону на LOCK_MS;
 * - IP: IP_MAX неудач за окно → блокировка адреса (перебор по многим телефонам с одного места).
 * Успешный вход сбрасывает счётчик телефона; смена PIN админом — тоже.
 */
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const PHONE_MAX = 5;
export const IP_MAX = 20;

export type AttemptState = { failures: number; windowStart: Date; lockedUntil: Date | null };

/** Чистая функция: новое состояние после неудачи. */
export function afterFailure(s: AttemptState | null, now: Date, max: number): AttemptState {
  const fresh = !s || now.getTime() - s.windowStart.getTime() > WINDOW_MS;
  const failures = (fresh ? 0 : s!.failures) + 1;
  return { failures, windowStart: fresh ? now : s!.windowStart, lockedUntil: failures >= max ? new Date(now.getTime() + LOCK_MS) : (s?.lockedUntil ?? null) };
}

export const isLocked = (s: AttemptState | null | undefined, now: Date) => !!s?.lockedUntil && s.lockedUntil > now;

export async function lockedFor(db: Db, phone: string, ip: string, now: Date): Promise<Date | null> {
  const rows = await db.select().from(authAttempt).where(inArray(authAttempt.key, [`phone:${phone}`, `ip:${ip}`]));
  const until = rows.filter((r) => isLocked(r, now)).map((r) => r.lockedUntil!.getTime());
  return until.length ? new Date(Math.max(...until)) : null;
}

/** Записать неудачу по телефону и IP. Возвращает, заблокирован ли теперь телефон (для журнала). */
export async function recordFailure(db: Db, phone: string, ip: string, now: Date): Promise<{ phoneLocked: boolean }> {
  let phoneLocked = false;
  for (const [key, max] of [[`phone:${phone}`, PHONE_MAX], [`ip:${ip}`, IP_MAX]] as const) {
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(authAttempt).where(eq(authAttempt.key, key)).for('update');
      const next = afterFailure(cur ?? null, now, max);
      if (key.startsWith('phone:') && !isLocked(cur, now) && isLocked(next, now)) phoneLocked = true;
      await tx
        .insert(authAttempt)
        .values({ key, ...next, updatedAt: now })
        .onConflictDoUpdate({ target: authAttempt.key, set: { ...next, updatedAt: now } });
    });
  }
  return { phoneLocked };
}

export async function resetPhone(db: Db, phone: string) {
  await db.delete(authAttempt).where(eq(authAttempt.key, `phone:${phone}`));
}

/** Уборка старых записей (ночная задача). */
export async function purgeAttempts(db: Db, now: Date) {
  await db.delete(authAttempt).where(sql`${authAttempt.updatedAt} < ${new Date(now.getTime() - 24 * 3600_000)}`);
}
