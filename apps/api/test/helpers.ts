import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp, createDeps } from '../src/app.js';
import * as s from '../src/shared/db/schema/index.js';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dark:dark@127.0.0.1:5432/dark_test';

export async function setupApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_URL,
    JWT_SECRET: 't'.repeat(32),
    LOG_LEVEL: 'warn',
    UPLOAD_DIR: `/tmp/dark-test-uploads-${process.pid}`,
  });
  let current = new Date('2026-11-27T07:00:00Z'); // 12:00 Душанбе, точка открыта
  const clock = { now: () => current };
  const deps = createDeps(config, { clock });
  const setNow = (d: Date) => {
    current = d;
  };
  await migrate(deps.db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
  await deps.db.execute(sql`truncate table ${s.notification}, ${s.authAttempt}, ${s.orderRating}, ${s.devicePresence}, ${s.outbox}, ${s.idempotencyKey}, ${s.auditLog}, ${s.parameter}, ${s.stockMove}, ${s.stockLot}, ${s.cell},
    ${s.promoUse}, ${s.promo}, ${s.paymentOp}, ${s.payment}, ${s.orderStatusLog}, ${s.orderItem}, ${s.order}, ${s.address}, ${s.customer},
    ${s.courier}, ${s.userStaff}, ${s.dish}, ${s.price}, ${s.product}, ${s.category}, ${s.deliveryZone}, ${s.store} cascade`);
  const app = await buildApp(deps);
  await app.ready();
  return { app, deps, setNow, close: async () => { await app.close(); await deps.close(); } };
}

/** Минимальный мир: точка, зона LAB, два товара с ценами и партиями, клиент с адресом. */
export async function seedWorld(deps: Awaited<ReturnType<typeof setupApp>>['deps']) {
  const db = deps.db;
  const hours = { open: '08:00', close: '23:00' };
  const [store] = await db.insert(s.store).values({ code: 'T-1', name: 'Тест', lat: 38.56, lon: 68.78, address: 'x', brands: ['LAB'], workHours: { thu: hours, fri: hours } }).returning();
  await db.insert(s.deliveryZone).values({ storeId: store!.id, brand: 'LAB', polygon: [[68.7, 38.5], [68.9, 38.5], [68.9, 38.6], [68.7, 38.6]], feeDirams: 1000, minOrderDirams: 2000, etaMin: 10, etaMax: 20 });
  const [p1, p2] = await db.insert(s.product).values([
    { brand: 'LAB', sku: 'A', nameRu: 'Вафли', barcodes: ['1'] },
    { brand: 'LAB', sku: 'B', nameRu: 'Молоко', barcodes: ['2'], tempZone: 'chill' },
  ]).returning();
  await db.insert(s.price).values([
    { productId: p1!.id, storeId: store!.id, priceDirams: 1250, validFrom: new Date('2026-01-01T00:00:00Z') },
    { productId: p2!.id, storeId: store!.id, priceDirams: 1100, validFrom: new Date('2026-01-01T00:00:00Z') },
  ]);
  const [cell] = await db.insert(s.cell).values({ storeId: store!.id, code: 'A-01-1', pickSeq: 1 }).returning();
  await db.insert(s.stockLot).values([
    { storeId: store!.id, productId: p1!.id, cellId: cell!.id, qty: 10 },
    { storeId: store!.id, productId: p2!.id, cellId: cell!.id, qty: 1 },
  ]);
  const [cust] = await db.insert(s.customer).values({ dcUserId: 'u-1' }).returning();
  const [addr] = await db.insert(s.address).values({ customerId: cust!.id, lat: 38.55, lon: 68.8, street: 'Рудаки', house: '1' }).returning();
  const { token } = await deps.tokens.sign({ kind: 'customer', customer_id: cust!.id, dc_user_id: 'u-1' });
  return { store: store!, p1: p1!, p2: p2!, cust: cust!, addr: addr!, token };
}
