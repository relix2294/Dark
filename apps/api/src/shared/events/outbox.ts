import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { outbox } from '../db/schema/index.js';
import type { Topic } from './topics.js';

export type DomainEvent = {
  topic: Topic;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

/** Публикация события — только внутри транзакции изменения. Так событие не теряется при сбое. */
export async function publish(tx: Tx, event: DomainEvent): Promise<void> {
  await tx.insert(outbox).values(event);
}

export type Subscriber = (event: DomainEvent & { id: string; createdAt: Date }) => Promise<void>;

/**
 * Relay: забирает неопубликованные события пачкой с блокировкой строк (SKIP LOCKED — можно
 * запускать несколько инстансов), доставляет подписчикам в памяти, отмечает published_at.
 */
export class OutboxRelay {
  private readonly subs = new Map<Topic | '*', Subscriber[]>();

  constructor(
    private readonly db: Db,
    private readonly log: { error: (o: unknown, msg?: string) => void } = console,
  ) {}

  on(topic: Topic | '*', fn: Subscriber): this {
    const list = this.subs.get(topic) ?? [];
    list.push(fn);
    this.subs.set(topic, list);
    return this;
  }

  /** Один проход. Возвращает число доставленных событий. */
  async tick(batch = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(and(isNull(outbox.publishedAt), lt(outbox.attempts, 10)))
        .orderBy(asc(outbox.createdAt))
        .limit(batch)
        .for('update', { skipLocked: true });

      let delivered = 0;
      for (const row of rows) {
        const handlers = [...(this.subs.get(row.topic as Topic) ?? []), ...(this.subs.get('*') ?? [])];
        try {
          for (const h of handlers) {
            await h({ ...row, topic: row.topic as Topic });
          }
          await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
          delivered++;
        } catch (err) {
          this.log.error({ err, event: row.id, topic: row.topic }, 'outbox: ошибка доставки');
          await tx
            .update(outbox)
            .set({ attempts: sql`${outbox.attempts} + 1`, lastError: String(err) })
            .where(eq(outbox.id, row.id));
        }
      }
      return delivered;
    });
  }
}
