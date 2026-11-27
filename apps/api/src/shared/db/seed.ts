/**
 * Демо-данные для локальной разработки: одна точка в Душанбе с обоими брендами, зона, товары, ячейки, партии,
 * сотрудники всех ролей (PIN 1234), промо NEW. Идемпотентен по store.code.
 */
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import * as s from './schema/index.js';
import { hashPin } from '../auth/index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const { db, close } = createDb(url);

await db.transaction(async (tx) => {
  const existing = await tx.select().from(s.store).where(eq(s.store.code, 'DSB-1'));
  if (existing.length) {
    console.log('Демо-данные уже есть');
    return;
  }
  const hours = { open: '08:00', close: '23:00' };
  const [store] = await tx
    .insert(s.store)
    .values({
      code: 'DSB-1',
      name: 'Душанбе, центр',
      lat: 38.5598,
      lon: 68.787,
      address: 'пр. Рудаки, 1',
      brands: ['LAB', 'SOR'],
      workHours: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: hours, sun: hours },
    })
    .returning();
  const polygon: [number, number][] = [
    [68.74, 38.53],
    [68.84, 38.53],
    [68.84, 38.59],
    [68.74, 38.59],
  ];
  await tx.insert(s.deliveryZone).values([
    { storeId: store!.id, brand: 'LAB', polygon, feeDirams: 1000, minOrderDirams: 3000, etaMin: 10, etaMax: 20 },
    { storeId: store!.id, brand: 'SOR', polygon, feeDirams: 1500, minOrderDirams: 5000, etaMin: 35, etaMax: 55 },
  ]);

  const [catLab] = await tx.insert(s.category).values({ brand: 'LAB', name: 'Снеки' }).returning();
  const [catSor] = await tx.insert(s.category).values({ brand: 'SOR', name: 'Пицца' }).returning();
  const products = await tx
    .insert(s.product)
    .values([
      { brand: 'LAB', sku: 'LAB-0001', nameRu: 'Вафли шоколадные', categoryId: catLab!.id, barcodes: ['4600000000011'], tempZone: 'ambient' },
      { brand: 'LAB', sku: 'LAB-0002', nameRu: 'Молоко 1 л', categoryId: catLab!.id, barcodes: ['4600000000028'], tempZone: 'chill', shelfLifeDays: 7 },
      { brand: 'LAB', sku: 'LAB-0003', nameRu: 'Бананы', categoryId: catLab!.id, barcodes: ['4600000000035'], unit: 'г', isWeighted: true },
      { brand: 'LAB', sku: 'LAB-0004', nameRu: 'Наушники', categoryId: catLab!.id, barcodes: ['4600000000042'], isHighValue: true },
      { brand: 'SOR', sku: 'SOR-0001', nameRu: 'Пицца Маргарита', categoryId: catSor!.id },
      { brand: 'SOR', sku: 'SOR-0002', nameRu: 'Салат Цезарь', categoryId: catSor!.id },
    ])
    .returning();
  const by = (sku: string) => products.find((p) => p.sku === sku)!;
  await tx.insert(s.price).values([
    { productId: by('LAB-0001').id, storeId: store!.id, priceDirams: 1250 },
    { productId: by('LAB-0002').id, storeId: store!.id, priceDirams: 1100 },
    { productId: by('LAB-0003').id, storeId: store!.id, priceDirams: 2200 }, // за кг
    { productId: by('LAB-0004').id, storeId: store!.id, priceDirams: 25000 },
    { productId: by('SOR-0001').id, storeId: store!.id, priceDirams: 6500 },
    { productId: by('SOR-0002').id, storeId: store!.id, priceDirams: 3900 },
  ]);
  await tx.insert(s.dish).values([
    { productId: by('SOR-0001').id, station: 'pizza', cookTimeSec: 900 },
    { productId: by('SOR-0002').id, station: 'cold', cookTimeSec: 240 },
  ]);

  const cells = await tx
    .insert(s.cell)
    .values([
      { storeId: store!.id, code: 'A-01-1', tempZone: 'ambient', pickSeq: 1 },
      { storeId: store!.id, code: 'A-01-2', tempZone: 'ambient', pickSeq: 2, isCameraCovered: true },
      { storeId: store!.id, code: 'C-01-1', tempZone: 'chill', pickSeq: 10 },
    ])
    .returning();
  const cellBy = (code: string) => cells.find((c) => c.code === code)!;
  const lots = await tx
    .insert(s.stockLot)
    .values([
      { storeId: store!.id, productId: by('LAB-0001').id, cellId: cellBy('A-01-1').id, qty: 40 },
      { storeId: store!.id, productId: by('LAB-0002').id, cellId: cellBy('C-01-1').id, qty: 20, expiresAt: new Date(Date.now() + 5 * 86_400_000) },
      { storeId: store!.id, productId: by('LAB-0003').id, cellId: cellBy('A-01-1').id, qty: 20000 },
      { storeId: store!.id, productId: by('LAB-0004').id, cellId: cellBy('A-01-2').id, qty: 3 },
    ])
    .returning();
  await tx.insert(s.stockMove).values(lots.map((l) => ({ storeId: l.storeId, productId: l.productId, lotId: l.id, type: 'receive' as const, qty: l.qty, reason: 'seed' })));

  const pin = hashPin('1234');
  const staff = await tx
    .insert(s.userStaff)
    .values([
      { phone: '+992900000001', name: 'Сборщик Али', role: 'picker', storeId: store!.id, pinHash: pin },
      { phone: '+992900000002', name: 'Повар Зафар', role: 'cook', storeId: store!.id, pinHash: pin },
      { phone: '+992900000003', name: 'Курьер Фируз', role: 'courier', storeId: store!.id, pinHash: pin },
      { phone: '+992900000004', name: 'Старший Нигора', role: 'shift_lead', storeId: store!.id, pinHash: pin },
      { phone: '+992900000005', name: 'Управляющий Далер', role: 'manager', storeId: store!.id, pinHash: pin },
      { phone: '+992900000006', name: 'Финансист Мадина', role: 'finance', storeId: null, pinHash: pin },
      { phone: '+992900000007', name: 'Админ', role: 'admin', storeId: null, pinHash: pin },
    ])
    .returning();
  await tx.insert(s.courier).values({ staffId: staff.find((u) => u.role === 'courier')!.id, transport: 'bike', currentStoreId: store!.id });

  await tx.insert(s.promo).values({ code: 'NEW', type: 'free_delivery', value: 0, audience: 'new', perCustomerLimit: 1, budgetDirams: 500_000 });
  console.log(`Точка ${store!.code} создана. Персонал: +99290000000{1..7}, PIN 1234.`);
});
await close();
