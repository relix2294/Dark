import type { Db, Tx } from './db/client.js';
import { auditLog } from './db/schema/index.js';

/**
 * Неизменяемый журнал действий (ТЗ §10): кто, когда, действие, объект, было, стало, причина. Хранение 3 года.
 * Обязателен для: цен, корректировок остатка, списаний, возвратов денег, отмен, ручного назначения,
 * промо, ролей и параметров. Пишется в той же транзакции, что и само изменение, когда она есть.
 */
export type AuditEntry = {
  actorType: 'staff' | 'system' | 'customer';
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null | undefined;
  storeId?: string | null | undefined;
};

export async function audit(db: Db | Tx, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    objectType: e.objectType,
    objectId: e.objectId,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
    storeId: e.storeId ?? null,
  });
}
