import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let token: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone: '+992900009999', name: 'Админ', role: 'admin', storeId: null, pinHash: hashPin('1234') }).returning();
  token = (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role: 'admin', store_id: null })).token;
});
afterAll(async () => ctx.close());

const run = async (rows: unknown[], dry_run: boolean) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/products/import',
    payload: { brand: 'LAB', store_id: w.store.id, rows, dry_run, reason: 'первичная загрузка' },
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
  });

describe('импорт каталога', () => {
  const good = [
    { sku: 'A', name_ru: 'Вафли шоколадные', price_dirams: 1300, category: 'Сладкое' },
    { sku: 'N-1', name_ru: 'Кефир', barcodes: ['4607001'], temp_zone: 'chill', category: 'Молочка', price_dirams: 900 },
    { sku: 'N-2', name_ru: 'Батон', barcodes: ['4607002'], category: 'Хлеб' },
  ];

  it('dry_run: сводка без записи', async () => {
    const r = await run(good, true);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ applied: false, created: 2, updated: 1, prices_changed: 2, categories_created: ['Сладкое', 'Молочка', 'Хлеб'], errors: [] });
    expect(await ctx.deps.db.select().from(s.product).where(eq(s.product.sku, 'N-1'))).toHaveLength(0);
  });

  it('ошибки по строкам блокируют применение целиком', async () => {
    const r = await run([...good, { sku: 'N-3', name_ru: '' }, { sku: 'N-1', name_ru: 'дубль' }, { sku: 'N-4', name_ru: 'x', barcodes: ['1'] }, { sku: 'N-5', name_ru: 'x', barcodes: ['4607002'] }], false);
    const j = r.json();
    expect(j.applied).toBe(false);
    expect(j.errors.map((e: any) => e.row)).toEqual([5, 6, 7, 8]);
    expect(j.errors[1].message).toContain('уже в строке 3');
    expect(j.errors[3].message).toContain('4607002');
    expect(await ctx.deps.db.select().from(s.product).where(eq(s.product.sku, 'N-1'))).toHaveLength(0);
  });

  it('штрихкод уже у другого товара в базе', async () => {
    await ctx.deps.db.insert(s.product).values({ brand: 'LAB', sku: 'Z', nameRu: 'Чужой', barcodes: ['4609999'] });
    const r = await run([{ sku: 'N-9', name_ru: 'x', barcodes: ['4609999'] }], true);
    expect(r.json().errors[0].message).toContain('LAB:Z');
  });

  it('применение: создание, обновление, история цен, категории, журнал', async () => {
    const r = await run(good, false);
    expect(r.json()).toMatchObject({ applied: true, created: 2, updated: 1, prices_changed: 2 });
    const [kefir] = await ctx.deps.db.select().from(s.product).where(eq(s.product.sku, 'N-1'));
    expect(kefir).toMatchObject({ nameRu: 'Кефир', tempZone: 'chill', barcodes: ['4607001'] });
    const prices = await ctx.deps.db.select().from(s.price).where(eq(s.price.productId, w.p1.id));
    expect(prices).toHaveLength(2);
    const [cur] = await ctx.deps.db.select().from(s.price).where(and(eq(s.price.productId, w.p1.id), isNull(s.price.validTo)));
    expect(cur!.priceDirams).toBe(1300);
    const [wf] = await ctx.deps.db.select().from(s.product).where(eq(s.product.id, w.p1.id));
    expect(wf!.nameRu).toBe('Вафли шоколадные');
    expect(wf!.barcodes).toEqual(['1']); // пустые штрихкоды в файле не стирают существующие
    const log = await ctx.deps.db.select().from(s.auditLog).where(eq(s.auditLog.action, 'catalog.import'));
    expect(log).toHaveLength(1);
    // повтор — ничего нового
    const again = (await run(good, true)).json();
    expect(again).toMatchObject({ created: 0, updated: 3, prices_changed: 0, categories_created: [] });
  });
});
