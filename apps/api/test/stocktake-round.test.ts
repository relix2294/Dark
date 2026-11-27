import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { planDailyStocktake, weekdayIndex } from '../src/modules/wms/admin.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
const TZ = 'Asia/Dushanbe';

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  // ещё 7 ячеек с товаром: всего 8 (A-01-1 из seedWorld — первая по обходу)
  for (let i = 2; i <= 8; i++) {
    const [c] = await ctx.deps.db.insert(s.cell).values({ storeId: w.store.id, code: `B-0${i}-1`, pickSeq: i }).returning();
    await ctx.deps.db.insert(s.stockLot).values({ storeId: w.store.id, productId: w.p1.id, cellId: c!.id, qty: i });
  }
});
afterAll(async () => ctx.close());

describe('инвентаризация: полный круг за неделю (ТЗ §7)', () => {
  it('день недели в поясе точки', () => {
    expect(weekdayIndex(new Date('2026-11-27T07:00:00Z'), TZ)).toBe(4); // пятница
    expect(weekdayIndex(new Date('2026-11-29T20:00:00Z'), TZ)).toBe(0); // в Душанбе уже понедельник 01:00
  });

  it('каждый день — седьмая часть ячеек по обходу; за 7 дней — все', async () => {
    const day = (d: number) => new Date(Date.parse('2026-11-23T07:00:00Z') + d * 86_400_000); // пн … вс
    const fri = await ctx.deps.db.transaction((tx) => planDailyStocktake(tx, w.store.id, { now: day(4), tz: TZ }));
    const lines = await ctx.deps.db.select({ code: s.cell.code }).from(s.stocktakeLine).innerJoin(s.cell, eq(s.cell.id, s.stocktakeLine.cellId)).where(eq(s.stocktakeLine.stocktakeId, fri.stocktake_id));
    expect(lines.map((l) => l.code)).toEqual(['B-05-1']); // пятая по обходу (индекс 4)

    for (const d of [0, 1, 2, 3, 5, 6]) await ctx.deps.db.transaction((tx) => planDailyStocktake(tx, w.store.id, { now: day(d), tz: TZ }));
    const all = await ctx.deps.db.select({ cellId: s.stocktakeLine.cellId }).from(s.stocktakeLine).where(eq(s.stocktakeLine.stocktakeId, fri.stocktake_id));
    expect(new Set(all.map((l) => l.cellId)).size).toBe(8);
    // без round — только дорогой товар, как раньше
    expect((await ctx.deps.db.transaction((tx) => planDailyStocktake(tx, w.store.id))).added).toBe(0);
  });
});
