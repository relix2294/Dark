// Импорт CSV в админке, пицца с модификаторами в витрине, состав блюда на экране кухни.
// Нужны API на :3000 (development) и pnpm dev. Запуск: node scripts/e2e-catalog.mjs.
import pw from 'playwright';
import { mkdirSync } from 'node:fs';
const S = process.env.SHOTS_DIR ?? '/tmp/dark-e2e';
mkdirSync(`${S}/shots`, { recursive: true });
const b = await pw.chromium.launch();
const errors = [];
const page = async (url, vp, extra = {}) => {
  const c = await b.newContext({ viewport: vp, ...extra });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/TUNNEL|WebSocket|Failed to load resource/.test(m.text()) && errors.push(`${url}: ${m.text()}`));
  await p.goto(url);
  return p;
};
const login = async (p, phone) => { await p.getByLabel('Телефон').fill(phone); await p.getByLabel('PIN').fill('1234'); await p.getByRole('button', { name: 'Войти' }).click(); };

// импорт
const o = await page('http://localhost:5172/office/', { width: 1360, height: 900 });
await login(o, '+992900000005');
await o.getByRole('button', { name: 'Импорт', exact: true }).click();
await o.locator('input[type=file]').setInputFiles(new URL('./fixtures/catalog-example.csv', import.meta.url).pathname);
await o.waitForSelector('text=3 строк');
await o.getByRole('button', { name: 'Проверить' }).click();
await o.waitForSelector('text=Проверка пройдена', { timeout: 10000 }).catch(async () => { await o.waitForSelector('text=обновится', { timeout: 5000 }); });
await o.screenshot({ path: `${S}/shots/import-check.png` });
const applyBtn = o.getByRole('button', { name: 'Применить' });
if (await applyBtn.isEnabled()) { await applyBtn.click(); await o.waitForSelector('text=Импорт применён', { timeout: 10000 }); }
await o.screenshot({ path: `${S}/shots/import-done.png` });
await o.getByRole('button', { name: 'Каталог', exact: true }).click();
await o.waitForSelector('text=Кефир 1%', { timeout: 10000 });

// витрина: пицца 35 см + сыр
const st = await page('http://localhost:5171/store/', { width: 420, height: 900 }, { geolocation: { latitude: 38.561, longitude: 68.79 }, permissions: ['geolocation'] });
await st.getByRole('button', { name: 'Войти' }).click();
await st.getByRole('button', { name: 'Sor Box' }).click();
const pizza = st.locator('.card', { hasText: 'Пицца Маргарита' });
await pizza.getByRole('button', { name: 'Выбрать' }).click();
await st.getByRole('button', { name: /35 см/ }).click();
await st.getByRole('button', { name: /Сыр/ }).click();
await st.screenshot({ path: `${S}/shots/store-modifiers.png` });
const add = st.getByRole('button', { name: /В корзину/ });
const addText = await add.textContent();
if (!addText.includes('98.00')) errors.push(`цена в выборе: ${addText}`);
await add.click();
await st.waitForSelector('text=Итого', { timeout: 10000 });
await st.screenshot({ path: `${S}/shots/store-cart-mod.png` });
await st.getByRole('button', { name: /Оплатить/ }).click();
await st.waitForSelector('text=Оплачен', { timeout: 15000 });
const num = (await st.locator('h1').textContent()).replace('Заказ ', '').trim();

// кухня видит состав
const k = await page('http://localhost:5173/kds/', { width: 1024, height: 700 });
await login(k, '+992900000002');
await k.getByRole('button', { name: 'Пицца', exact: true }).click();
await k.waitForSelector(`text=Заказ ${num}`, { timeout: 15000 });
const card = await k.locator('.card', { hasText: `Заказ ${num}` }).textContent();
if (!card.includes('35 см') || !card.includes('Сыр')) errors.push(`кухня не видит модификаторы: ${card}`);
await k.screenshot({ path: `${S}/shots/kds-modifiers.png` });
console.log('order', num);
console.log('errors:', errors.length ? errors : 'none');
await b.close();
