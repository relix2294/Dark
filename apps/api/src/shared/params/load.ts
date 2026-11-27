import { eq, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { parameter } from '../db/schema/index.js';
import { resolveParams, type ParamKey, type Params } from './index.js';

/**
 * Параметры точки (ТЗ §12): значения по умолчанию ← общие переопределения (store_id = null) ← переопределения точки.
 * Кэш 10 с на процесс; запись через админку сбрасывает кэш сразу (на других инстансах — не позже чем через 10 с).
 * Таблицей parameter владеет backoffice (запись), читать её можно отсюда.
 */
const cache = new Map<string, { p: Params; at: number }>();
const TTL_MS = 10_000;

export async function loadParams(db: Db | Tx, storeId: string | null): Promise<Params> {
  const key = storeId ?? '*';
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL_MS) return c.p;
  const rows = await db
    .select()
    .from(parameter)
    .where(storeId ? or(isNull(parameter.storeId), eq(parameter.storeId, storeId)) : isNull(parameter.storeId));
  const overrides: Partial<Record<ParamKey, unknown>> = {};
  // сначала общие, поверх — точки
  for (const r of rows.filter((x) => x.storeId === null)) overrides[r.key as ParamKey] = r.value;
  for (const r of rows.filter((x) => x.storeId !== null)) overrides[r.key as ParamKey] = r.value;
  const p = resolveParams(overrides);
  cache.set(key, { p, at: Date.now() });
  return p;
}

export function invalidateParams(storeId?: string | null) {
  if (storeId === undefined) cache.clear();
  else cache.delete(storeId ?? '*');
}

