import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWorld, setupApp } from './helpers.js';
import * as s from '../src/shared/db/schema/index.js';
import { hashPin } from '../src/shared/auth/index.js';

/** Фото товаров: загрузка байтами, проверка содержимого, раздача из локального хранилища. */
let ctx: Awaited<ReturnType<typeof setupApp>>;
let w: Awaited<ReturnType<typeof seedWorld>>;
let manager: string;
let picker: string;

// минимальный валидный PNG 1×1
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  ctx = await setupApp();
  w = await seedWorld(ctx.deps);
  const mk = async (phone: string, role: 'manager' | 'picker') => {
    const [u] = await ctx.deps.db.insert(s.userStaff).values({ phone, name: role, role, storeId: w.store.id, pinHash: hashPin('1234') }).returning();
    return (await ctx.deps.tokens.sign({ kind: 'staff', staff_id: u!.id, role, store_id: w.store.id })).token;
  };
  manager = await mk('+992900000701', 'manager');
  picker = await mk('+992900000702', 'picker');
});
afterAll(async () => ctx.close());

const upload = (token: string, body: Buffer, type = 'image/png') =>
  ctx.app.inject({ method: 'POST', url: `/api/v1/admin/products/${w.p1.id}/photo`, payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': type } });

describe('фото товаров', () => {
  it('загрузка PNG: адрес по хэшу, товар обновлён, файл отдаётся', async () => {
    const r = await upload(manager, PNG);
    expect(r.statusCode, r.body).toBe(200);
    const url: string = r.json().photo_url;
    expect(url).toMatch(new RegExp(`^/media/products/${w.p1.id}/[0-9a-f]{16}\\.png$`));
    const again = await upload(manager, PNG);
    expect(again.json().photo_url).toBe(url); // тот же файл — тот же адрес
    const file = await ctx.app.inject({ method: 'GET', url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(PNG)).toBe(true);
    const cat = (await ctx.app.inject({ method: 'GET', url: `/api/v1/catalog?store_id=${w.store.id}&brand=LAB` })).json();
    expect(cat.items.find((i: any) => i.product_id === w.p1.id).photo_url).toBe(url);
  });

  it('не картинка (подмена типа) — 400; сборщику нельзя; выход за каталог — 404', async () => {
    const fake = await upload(manager, Buffer.from('<?php echo 1; ?>'), 'image/png');
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.message).toContain('не JPEG');
    expect((await upload(picker, PNG)).statusCode).toBe(403);
    const trav = await ctx.app.inject({ method: 'GET', url: '/media/..%2F..%2Fetc%2Fpasswd' });
    expect(trav.statusCode).toBe(404);
  });
});
