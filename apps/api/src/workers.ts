import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './app.js';
import { OutboxRelay } from './shared/events/outbox.js';
import { registerNotifySubscribers } from './modules/notify/index.js';

/**
 * Фоновые задачи на pg-boss (очередь в самом Postgres — без Redis).
 * - outbox.relay: доставка событий подписчикам (каждые 2 с);
 * - payments.reconcile: платежи в *_pending старше 60 с (каждую минуту);
 * - dispatch.tick: диспетчер по каждой точке (каждые 15 с, ТЗ §6);
 * - housekeeping: чистка courier_position старше 30 дней, истёкших ключей идемпотентности (ночью).
 */
export async function startWorkers(deps: AppDeps, log: FastifyBaseLogger) {
  const boss = new PgBoss({ connectionString: deps.config.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss'));
  await boss.start();

  const relay = new OutboxRelay(deps.db, log);
  registerNotifySubscribers(relay, log);

  for (const q of ['outbox.relay', 'payments.reconcile', 'dispatch.tick', 'housekeeping']) {
    await boss.createQueue(q);
  }

  await boss.work('outbox.relay', async () => {
    let n = 0;
    do n = await relay.tick();
    while (n > 0);
  });
  await boss.work('payments.reconcile', async () => {
    // TODO(payments): опрос status() для платежей в *_pending старше PENDING_STALE_MS (ТЗ §5 п.4)
  });
  await boss.work('dispatch.tick', async () => {
    // TODO(dispatch): собрать DispatchInput по каждой активной точке → planDispatch → применить в транзакции
  });
  await boss.work('housekeeping', async () => {
    // TODO: delete from courier_position where at < now() - interval '30 days'
  });

  await boss.schedule('outbox.relay', '* * * * *'); // минимум cron — минута; внутри tick выгребает всё
  await boss.schedule('payments.reconcile', '* * * * *');
  await boss.schedule('dispatch.tick', '* * * * *');
  await boss.schedule('housekeeping', '0 3 * * *', {}, { tz: 'Asia/Dushanbe' });

  // Частые тики без ожидания cron: outbox и диспетчер
  const fast = setInterval(() => {
    void boss.send('outbox.relay', {}, { singletonKey: 'relay', singletonSeconds: 2 });
    void boss.send('dispatch.tick', {}, { singletonKey: 'dispatch', singletonSeconds: 15 });
  }, 2000);

  return {
    boss,
    relay,
    stop: async () => {
      clearInterval(fast);
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
