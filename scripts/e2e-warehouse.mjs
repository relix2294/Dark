// Склад в админке: сроки, создание пересчёта, внутренний штрихкод и этикетка нового товара.
// Нужны API на :3000 и pnpm dev. Запуск: node scripts/e2e-warehouse.mjs.
import pw from 'playwright';
import { mkdirSync } from 'node:fs';
const S = process.env.SHOTS_DIR ?? '/tmp/dark-e2e';
mkdirSync(S, { recursive: true });
const b = await pw.chromium.launch();
const errors = [];
const c = await b.newContext({ viewport: { width: 1360, height: 900 } });
const o = await c.newPage();
o.on('pageerror', (e) => errors.push(e.message));
o.on('console', (m) => m.type() === 'error' && !/TUNNEL|WebSocket|Failed to load resource/.test(m.text()) && errors.push(m.text()));
await o.goto('http://localhost:5172/office/');
await o.getByLabel('Телефон').fill('+992900000005');
await o.getByLabel('PIN').fill('1234');
await o.getByRole('button', { name: 'Войти' }).click();
await o.getByRole('button', { name: 'Склад', exact: true }).click();
await o.getByRole('button', { name: 'Сроки', exact: true }).click();
await o.waitForTimeout(800);
await o.screenshot({ path: `${S}/wh-expiring.png` });
await o.getByRole('button', { name: 'Инвентаризация', exact: true }).click();
await o.getByPlaceholder('ячейки: A-01-1, A-02-1').fill('A-01-1, A-01-2');
await o.getByRole('button', { name: 'Пересчёт ячеек' }).click();
await o.waitForSelector('text=Ячейки ·', { timeout: 10000 });
await o.screenshot({ path: `${S}/wh-stocktake.png` });
// новый товар без штрихкода → внутренний код и этикетка
const RUN = String(Date.now()).slice(-6);
await o.getByRole('button', { name: 'Каталог', exact: true }).click();
await o.getByRole('button', { name: '+ Товар' }).click();
await o.getByLabel('Артикул').fill(`NB-${RUN}`);
await o.getByLabel('Название (рус.)').fill(`Кинза пучок ${RUN}`);
await o.getByLabel(/Цена на точке/).fill('5');
await o.getByRole('button', { name: 'Сохранить' }).click();
await o.getByText(`Кинза пучок ${RUN}`).click();
await o.waitForSelector('svg[aria-label^="штрихкод 200"]', { timeout: 10000 });
await o.screenshot({ path: `${S}/wh-label.png` });
console.log('errors:', errors.length ? errors : 'none');
await b.close();
