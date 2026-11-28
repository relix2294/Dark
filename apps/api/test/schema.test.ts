import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setupApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());

describe('инварианты схемы', () => {
  it('у каждой таблицы с updated_at есть триггер set_updated_at (новая таблица → строка в миграции инвариантов)', async () => {
    const r = await ctx.deps.db.execute<{ table_name: string }>(sql`
      select c.table_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'updated_at'
        and c.table_name not in ('audit_log', 'order_status_log', 'stock_move')
        and not exists (select 1 from pg_trigger g where g.tgname = c.table_name || '_updated_at')`);
    expect(r.rows.map((x) => x.table_name)).toEqual([]);
  });
});
