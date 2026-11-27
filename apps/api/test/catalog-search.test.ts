import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let dairy: string;

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const [c1, c2] = await ctx.deps.db.insert(s.category).values([
    { brand: 'LAB', name: 'Молочное', sort: 2 },
    { brand: 'LAB', name: 'Сладкое', sort: 1 },
  ]).returning();
  dairy = c1!.id;
  await ctx.deps.db.update(s.product).set({ categoryId: c1!.id, nameTj: 'Шир', barcodes: ['4600000000017'] }).where(eq(s.product.id, w.p2.id));
  await ctx.deps.db.update(s.product).set({ categoryId: c2!.id, nameRu: 'Вафли 100%' }).where(eq(s.product.id, w.p1.id));
});
afterAll(async () => ctx.close());

const get = async (qs: string) => (await ctx.app.inject({ method: 'GET', url: `/api/v1/catalog?store_id=${w.store.id}&brand=LAB${qs}` })).json();
const names = (r: { items: { name_ru: string }[] }) => r.items.map((i) => i.name_ru);

describe('каталог витрины: поиск и категории (ТЗ §9)', () => {
  it('категории с числом товаров в порядке сортировки', async () => {
    const r = await get('');
    expect(r.categories).toEqual([
      { id: expect.any(String), name: 'Сладкое', count: 1 },
      { id: dairy, name: 'Молочное', count: 1 },
    ]);
    expect(names(r)).toEqual(['Вафли 100%', 'Молоко']);
    expect(names(await get(`&category=${dairy}`))).toEqual(['Молоко']);
  });

  it('поиск по названию, таджикскому названию, штрихкоду; % и _ — буквально', async () => {
    expect(names(await get('&q=молок'))).toEqual(['Молоко']);
    expect(names(await get(`&q=${encodeURIComponent('шир')}`))).toEqual(['Молоко']);
    expect(names(await get('&q=4600000000017'))).toEqual(['Молоко']);
    expect(names(await get(`&q=${encodeURIComponent('%')}`))).toEqual(['Вафли 100%']);
    expect(names(await get('&q=_'))).toEqual([]);
    // категории не зависят от поиска
    expect((await get('&q=молок')).categories).toHaveLength(2);
  });
});
