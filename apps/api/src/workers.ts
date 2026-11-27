import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import { eq, and, lt, sql } from 'drizzle-orm';
import type { AppDeps } from './app.js';
import { OutboxRelay } from './shared/events/outbox.js';
import { courierPosition, idempotencyKey, store } from './shared/db/schema/index.js';
import { detectDelays, registerNotifySubscribers, sendPending, smsFallback } from './modules/notify/index.js';
import { registerRealtimeSubscriber } from './modules/realtime/index.js';
import { dispatchStore } from './modules/dispatch/index.js';
import { CAPTURE_RETRY_DELAYS_SEC, executeCapture, nightlyReconcile, reconcilePending, releaseOrphanHolds, warnExpiringHolds } from './modules/payments/index.js';
import { markPaymentFailed } from './modules/orders/index.js';
import { planDailyStocktake } from './modules/wms/index.js';
import { purgeAttempts } from './modules/customers/index.js';

/**
 * Фоновые задачи на pg-boss (очередь в самом Postgres — без Redis).
 * - outbox.relay: доставка событий подписчикам (каждые 2 с);
 * - dispatch.tick: диспетчер по каждой активной точке (каждые 15 с, ТЗ §6);
 * - payments.reconcile: платежи в *_pending старше 60 с (каждую минуту, ТЗ §5);
 * - payments.nightly: ночная сверка списаний и возвратов с банком (04:00 Душанбе, ТЗ §5);
 * - payments.capture: повтор списания 1, 5, 15 мин, затем раз в час сутки, потом тревога (ТЗ §5 п.7);
 * - housekeeping: courier_position старше 30 дней, ключи идемпотентности старше 7 дней (03:00 Душанбе).
 */
export async function startWorkers(deps: AppDeps, log: FastifyBaseLogger) {
  const boss = new PgBoss({ connectionString: deps.config.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss'));
  await boss.start();

  const relay = new OutboxRelay(deps.db, log);
  registerNotifySubscribers(relay, deps, log);
  registerRealtimeSubscriber(relay, deps.db);

  for (const q of ['outbox.relay', 'payments.reconcile', 'payments.capture', 'payments.nightly', 'dispatch.tick', 'housekeeping']) await boss.createQueue(q);

  await boss.work('outbox.relay', async () => {
    let n = 0;
    do n = await relay.tick();
    while (n > 0);
    // уведомления клиенту: отправка сразу за событиями, SMS — когда пуш не доставлен за 30 с
    await sendPending(deps);
    await smsFallback(deps);
  });

  await boss.work('dispatch.tick', async () => {
    const stores = await deps.db.select({ id: store.id }).from(store).where(eq(store.isActive, true));
    for (const s of stores) {
      try {
        const r = await dispatchStore(deps, s.id);
        if (r.assigned || r.alerts) log.info({ store_id: s.id, ...r }, 'dispatch');
      } catch (err) {
        log.error({ err, store_id: s.id }, 'dispatch: ошибка');
      }
    }
  });

  await boss.work('payments.reconcile', async () => {
    const r = await reconcilePending(deps);
    if (r.failedOrderIds.length) await markPaymentFailed(deps, r.failedOrderIds);
    for (const paymentId of r.retryCaptureIds) await boss.send('payments.capture', { paymentId, attempt: 0 }, { singletonKey: paymentId, singletonSeconds: 60 });
    await detectDelays(deps);
    const orphans = await releaseOrphanHolds(deps);
    if (orphans.length) log.warn({ order_ids: orphans }, 'payments: сняты холды у завершённых заказов');
    await warnExpiringHolds(deps);
  });

  await boss.work('payments.nightly', async () => {
    const r = await nightlyReconcile(deps, deps.clock.now());
    log.info({ checked: r.checked, mismatches: r.mismatches.length }, 'ночная сверка платежей');
  });

  await boss.work<{ paymentId: string; attempt: number }>('payments.capture', async ([job]) => {
    if (!job) return;
    const { paymentId, attempt } = job.data;
    const r = await executeCapture(deps, paymentId);
    if (r.ok) return;
    const delay = CAPTURE_RETRY_DELAYS_SEC[attempt];
    if (delay === undefined) {
      log.error({ payment_id: paymentId }, 'capture не прошёл за сутки — тревога финансисту');
      return;
    }
    await boss.send('payments.capture', { paymentId, attempt: attempt + 1 }, { startAfter: delay, singletonKey: paymentId, singletonSeconds: delay });
  });

  await boss.work('housekeeping', async () => {
    const now = deps.clock.now();
    // утренний план выборочной инвентаризации: дорогие товары во всех ячейках с камерой (ТЗ §7)
    const stores = await deps.db.select({ id: store.id }).from(store).where(eq(store.isActive, true));
    for (const s of stores) await deps.db.transaction((tx) => planDailyStocktake(tx, s.id));
    await purgeAttempts(deps.db, now);
    await deps.db.delete(courierPosition).where(lt(courierPosition.at, new Date(now.getTime() - 30 * 86_400_000)));
    await deps.db.delete(idempotencyKey).where(and(lt(idempotencyKey.createdAt, new Date(now.getTime() - 7 * 86_400_000)), sql`${idempotencyKey.completedAt} is not null`));
  });

  await boss.schedule('outbox.relay', '* * * * *');
  await boss.schedule('payments.reconcile', '* * * * *');
  await boss.schedule('dispatch.tick', '* * * * *');
  await boss.schedule('housekeeping', '0 3 * * *', {}, { tz: 'Asia/Dushanbe' });
  await boss.schedule('payments.nightly', '0 4 * * *', {}, { tz: 'Asia/Dushanbe' });

  // Частые тики без ожидания cron
  const fast = setInterval(() => {
    void boss.send('outbox.relay', {}, { singletonKey: 'relay', singletonSeconds: 2 });
    void boss.send('dispatch.tick', {}, { singletonKey: 'dispatch', singletonSeconds: 15 });
  }, 2000);

  return {
    boss,
    relay,
    /** Поставить повтор списания из обработчика доставки (если первый capture не прошёл). */
    scheduleCapture: (paymentId: string) => boss.send('payments.capture', { paymentId, attempt: 0 }, { startAfter: CAPTURE_RETRY_DELAYS_SEC[0] ?? 60, singletonKey: paymentId }),
    stop: async () => {
      clearInterval(fast);
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
