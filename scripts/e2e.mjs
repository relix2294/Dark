// Сквозной сценарий в браузере: витрина → сборщик → диспетчер → курьер → пульт → кухня.
// Нужны: API на :3000 с демо-данными (pnpm db:seed), dev-серверы всех приложений (pnpm dev), playwright.
// Запуск: pnpm e2e. Скриншоты — в $SHOTS_DIR (по умолчанию /tmp/dark-e2e).
import pw from 'playwright';
const { chromium } = pw;
const S = process.env.SHOTS_DIR ?? '/tmp/dark-e2e';
import { mkdirSync } from 'node:fs';
mkdirSync(S, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 1, geolocation: { latitude: 38.561, longitude: 68.79 }, permissions: ['geolocation'] });
const log = (...a) => console.log(...a);
const errors = [];
const page = async (url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`)); p.on('console', (m) => m.type() === 'error' && errors.push(`${url} console: ${m.text()}`)); await p.goto(url); return p; };

// 1. Витрина: вход, адрес, каталог, заказ
const store = await page('http://localhost:5171/store/');
await store.getByRole('button', { name: 'Войти' }).click();
await store.waitForSelector('text=Адрес доставки', { timeout: 10000 });
await store.getByLabel('Улица').fill('Рудаки');
await store.getByLabel('Дом').fill('12');
await store.getByRole('button', { name: 'Сохранить адрес' }).click();
await store.waitForSelector('text=Вафли шоколадные', { timeout: 10000 });
await store.screenshot({ path: `${S}/1-store-catalog.png` });
const waffles = store.locator('.card', { hasText: 'Вафли шоколадные' });
await waffles.getByRole('button', { name: '+' }).click();
await waffles.getByRole('button', { name: '+' }).click();
await waffles.getByRole('button', { name: '+' }).click();
await store.waitForSelector('text=Итого', { timeout: 10000 });
await store.screenshot({ path: `${S}/2-store-cart.png` });
await store.getByRole('button', { name: /Оплатить/ }).click();
await store.waitForSelector('text=Оплачен', { timeout: 15000 });
const orderNumber = (await store.locator('h1').textContent()).replace('Заказ ', '').trim();
log('заказ', orderNumber);
await store.screenshot({ path: `${S}/3-store-tracking.png` });

// 2. Терминал сборщика: вход, задание, сканы, завершение
const pick = await page('http://localhost:5174/picker/');
await pick.getByLabel('Телефон').fill('+992900000001');
await pick.getByLabel('PIN').fill('1234');
await pick.getByRole('button', { name: 'Войти' }).click();
await pick.waitForSelector(`text=Заказ ${orderNumber}`, { timeout: 15000 });
await pick.screenshot({ path: `${S}/4-picker-task.png` });
const scan = async (code) => { await pick.keyboard.type(code, { delay: 5 }); await pick.keyboard.press('Enter'); await pick.waitForTimeout(300); };
await scan('A-01-1');
await scan('4600000000011'); // 3 шт → numpad с 3
await pick.waitForSelector('.numpad', { timeout: 5000 });
await pick.screenshot({ path: `${S}/5-picker-qty.png` });
await pick.getByRole('button', { name: 'OK' }).click();
await pick.waitForSelector('text=Завершить сборку', { timeout: 10000 });
await pick.getByRole('button', { name: /Завершить сборку/ }).click();
await pick.waitForSelector(`text=PKG-${orderNumber}`, { timeout: 10000 });
await pick.screenshot({ path: `${S}/6-picker-label.png` });

// 3. Витрина увидела «Готов»
await store.waitForSelector('text=Готов', { timeout: 15000 });

// 4. Курьер: смена, задание через диспетчер (ждём тик до 20 с), скан, доставка
const cour = await page('http://localhost:5175/courier/');
await cour.getByLabel('Телефон').fill('+992900000003');
await cour.getByLabel('PIN').fill('1234');
await cour.getByRole('button', { name: 'Войти' }).click();
await cour.waitForSelector('text=Начать смену', { timeout: 10000 });
await cour.getByRole('button', { name: 'Начать смену' }).click();
await cour.waitForSelector(`text=${orderNumber}`, { timeout: 40000 });
await cour.screenshot({ path: `${S}/7-courier-task.png` });
await cour.getByLabel('Или введите код вручную').fill(`PKG-${orderNumber}`);
await cour.getByRole('button', { name: '+' }).click();
await cour.getByRole('button', { name: /Забрал пакеты/ }).click();
await cour.waitForSelector('text=Доставлено', { timeout: 10000 });
await store.waitForSelector('text=В пути', { timeout: 15000 });
await store.screenshot({ path: `${S}/8-store-on-the-way.png` });

// 5. Пульт
const office = await page('http://localhost:5172/office/');
await office.setViewportSize({ width: 1280, height: 800 });
await office.getByLabel('Телефон').fill('+992900000004');
await office.getByLabel('PIN').fill('1234');
await office.getByRole('button', { name: 'Войти' }).click();
await office.waitForSelector(`text=${orderNumber}`, { timeout: 15000 });
await office.screenshot({ path: `${S}/9-office-console.png` });

// 6. Кухня
const kds = await page('http://localhost:5173/kds/');
await kds.setViewportSize({ width: 1024, height: 700 });
await kds.getByLabel('Телефон').fill('+992900000002');
await kds.getByLabel('PIN').fill('1234');
await kds.getByRole('button', { name: 'Войти' }).click();
await kds.waitForSelector('text=Очередь пуста', { timeout: 15000 });
await kds.screenshot({ path: `${S}/10-kds.png` });

// доставка курьером (геопозиция эмулируется в 38.561,68.79; адрес — по геолокации, тоже 38.561,68.79)
await cour.getByRole('button', { name: 'Доставлено' }).click();
await cour.waitForSelector('text=Заданий нет', { timeout: 15000 });
await store.waitForSelector('text=Доставлен', { timeout: 15000 });
await store.screenshot({ path: `${S}/11-store-delivered.png` });

log('errors:', errors.length ? errors : 'none');
await browser.close();
