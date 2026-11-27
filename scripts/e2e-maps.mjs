// Карты: пульт (точка, курьеры, заказы), рисование полигона зоны кликами, адрес в витрине с проверкой зоны.
// Нужны API на :3000 в режиме development (dev-токены DC Next) и pnpm dev. Запуск: node scripts/e2e-maps.mjs.
import pw from 'playwright';
const { chromium } = pw;
import { mkdirSync } from 'node:fs';
const S = process.env.SHOTS_DIR ?? '/tmp/dark-e2e';
mkdirSync(S, { recursive: true });
const b = await chromium.launch();
const errors = [];
const page = async (url, vp, extra = {}) => {
  const c = await b.newContext({ viewport: vp, ...extra });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  // тайлы OSM в песочнице недоступны — эти ошибки ожидаемы
  p.on('console', (m) => m.type() === 'error' && !/tile|ERR_TUNNEL|ERR_CONNECTION|WebSocket|Failed to load resource/.test(m.text()) && errors.push(`${url}: ${m.text()}`));
  await p.goto(url);
  return p;
};
// пульт: карта и зоны с рисованием
const o = await page('http://localhost:5172/office/', { width: 1360, height: 900 });
await o.getByLabel('Телефон').fill('+992900000005');
await o.getByLabel('PIN').fill('1234');
await o.getByRole('button', { name: 'Войти' }).click();
await o.waitForSelector('.map', { timeout: 15000 });
await o.waitForTimeout(800);
await o.screenshot({ path: `${S}/map-console.png` });
await o.getByRole('button', { name: 'Зоны', exact: true }).click();
await o.waitForSelector('.leaflet-interactive', { timeout: 10000 });
await o.getByRole('button', { name: '+ Зона' }).click();
const ed = o.locator('.modal .map');
await ed.waitFor();
const box = await ed.boundingBox();
for (const [dx, dy] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]) await o.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
const poly = await o.locator('.modal textarea').inputValue();
if (JSON.parse(poly).length !== 4) errors.push(`полигон не нарисован: ${poly}`);
await o.screenshot({ path: `${S}/map-zone-editor.png` });
// витрина: адрес на карте, проверка зоны
const st = await page('http://localhost:5171/store/', { width: 420, height: 900 }, { geolocation: { latitude: 38.561, longitude: 68.79 }, permissions: ['geolocation'] });
await st.getByRole('button', { name: 'Войти' }).click();
await st.waitForSelector('text=Каталог', { timeout: 10000 });
await st.getByRole('button', { name: 'Новый' }).click().catch(() => {});
await st.waitForSelector('.map', { timeout: 10000 });
await st.waitForSelector('text=В зоне доставки', { timeout: 10000 });
await st.screenshot({ path: `${S}/map-store-address.png` });
console.log('errors:', errors.length ? errors : 'none');
await b.close();
