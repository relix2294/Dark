import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { DeviceApp, StaffPrincipal } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { devicePresence, userStaff } from '../../shared/db/schema/index.js';
import { publish } from '../../shared/events/outbox.js';
import { getStore, isOpenAt } from '../catalog/index.js';

/** Тишина, после которой устройство «не на связи» (ТЗ §10: 2 минуты). */
export const OFFLINE_AFTER_MS = 2 * 60_000;
/** Устройство, молчащее дольше, считаем выключенным давно — не тревожим (терминал убрали без выхода). */
const FORGET_AFTER_MS = 12 * 3600_000;

/** Пульс устройства. Перехватывает device_id у прежней точки/сотрудника; bye — штатный выход. */
export async function heartbeat(deps: AppDeps, me: StaffPrincipal, input: { device_id: string; app: DeviceApp; bye?: boolean | undefined }) {
  if (!me.store_id) return; // админ без точки — не устройство точки
  const now = deps.clock.now();
  const row = { storeId: me.store_id, app: input.app, staffId: me.staff_id, lastSeenAt: now, signedOffAt: input.bye ? now : null, offlineAlertedAt: null };
  await deps.db
    .insert(devicePresence)
    .values({ deviceId: input.device_id, ...row })
    .onConflictDoUpdate({ target: devicePresence.deviceId, set: row });
}

/** Устройства точки за последние 12 часов (без штатно вышедших) — для пульта. */
export async function storeDevices(deps: AppDeps, storeId: string) {
  const now = deps.clock.now();
  const rows = await deps.db
    .select({ d: devicePresence, name: userStaff.name })
    .from(devicePresence)
    .leftJoin(userStaff, eq(userStaff.id, devicePresence.staffId))
    .where(and(eq(devicePresence.storeId, storeId), isNull(devicePresence.signedOffAt), gt(devicePresence.lastSeenAt, new Date(now.getTime() - FORGET_AFTER_MS))))
    .orderBy(devicePresence.app, devicePresence.lastSeenAt);
  return {
    devices: rows.map((r) => ({
      device_id: r.d.deviceId,
      app: r.d.app,
      staff_name: r.name,
      last_seen_at: r.d.lastSeenAt.toISOString(),
      online: now.getTime() - r.d.lastSeenAt.getTime() <= OFFLINE_AFTER_MS,
    })),
  };
}

/**
 * Раз в минуту (воркер): устройства, молчащие дольше 2 минут, на открытой точке → device.offline.
 * Одна тревога на эпизод: следующий пульс сбрасывает offline_alerted_at.
 */
export async function detectOfflineDevices(deps: AppDeps) {
  const now = deps.clock.now();
  const silent = await deps.db
    .select({ d: devicePresence, name: userStaff.name })
    .from(devicePresence)
    .leftJoin(userStaff, eq(userStaff.id, devicePresence.staffId))
    .where(
      and(
        isNull(devicePresence.signedOffAt),
        isNull(devicePresence.offlineAlertedAt),
        lt(devicePresence.lastSeenAt, new Date(now.getTime() - OFFLINE_AFTER_MS)),
        gt(devicePresence.lastSeenAt, new Date(now.getTime() - FORGET_AFTER_MS)),
      ),
    );
  const openCache = new Map<string, boolean>();
  let alerts = 0;
  for (const { d, name } of silent) {
    if (!openCache.has(d.storeId)) {
      const st = await getStore(deps, d.storeId);
      openCache.set(d.storeId, st.isActive && isOpenAt(st.workHours, now, deps.config.DISPLAY_TZ));
    }
    if (!openCache.get(d.storeId)) continue; // вне рабочего времени тишина нормальна
    await deps.db.transaction(async (tx) => {
      // условный update — защита от двух воркеров и от пульса, пришедшего между выборкой и записью
      const [hit] = await tx
        .update(devicePresence)
        .set({ offlineAlertedAt: now })
        .where(and(eq(devicePresence.deviceId, d.deviceId), isNull(devicePresence.offlineAlertedAt), eq(devicePresence.lastSeenAt, d.lastSeenAt)))
        .returning({ id: devicePresence.deviceId });
      if (!hit) return;
      await publish(tx, {
        topic: 'device.offline',
        aggregateType: 'device',
        aggregateId: d.deviceId,
        payload: { store_id: d.storeId, app: d.app, staff_name: name, last_seen_at: d.lastSeenAt.toISOString() },
      });
      alerts++;
    });
  }
  return alerts;
}

