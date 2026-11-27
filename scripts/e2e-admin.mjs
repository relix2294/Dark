// Сквозной сценарий админки и офлайн-сборки: все вкладки под управляющим, новый товар с ценой, промо, журнал,
// витрина не показывает товар без остатка, сборщик сканирует без сети и очередь уходит при восстановлении,
// пульт видит готовый заказ через WebSocket. Нужны API на :3000 (dev-база с pnpm db:seed) и pnpm dev. Запуск: pnpm e2e:admin.
import pw from 'playwright';
const { chromium } = pw;
import { execSync } from 'node:child_process';
// dev-база переживает прогоны: закрываем хвосты незавершённых заказов прошлых запусков
execSync(`PGPASSWORD=dark psql -h 127.0.0.1 -U dark -d dark -q -c "update pick_task set status='abandoned' where status='open'" -c "update stock_lot set reserved_qty=0" -c "update \\"order\\" set status='cancelled' where status in ('paid_hold','picking','created','ready')"`);
import { mkdirSync } from 'node:fs';
const S = process.env.SHOTS_DIR ?? '/tmp/dark-e2e';
mkdirSync(S, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const RUN = String(Date.now()).slice(-6);
const mk = async (url, vp, geo) => {
  const ctx = await browser.newContext({ viewport: vp, ...(geo ? { geolocation: geo, permissions: ['geolocation'] } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('WebSocket') && errors.push(`${url} console: ${m.text()}`));
  await p.goto(url);
  return { ctx, p };
};
const login = async (p, phone) => {
  await p.getByLabel('Телефон').fill(phone);
  await p.getByLabel('PIN').fill('1234');
  await p.getByRole('button', { name: 'Войти' }).click();
};

// ---- Админка под управляющим
const { p: o } = await mk('http://localhost:5172/office/', { width: 1360, height: 860 });
await login(o, '+992900000005');
await o.waitForSelector('text=онлайн', { timeout: 15000 });
for (const tab of ['Каталог', 'Склад', 'Зоны', 'Промо', 'Персонал', 'Курьеры', 'Отчёты', 'Параметры', 'Журнал', 'Пульт']) {
  await o.getByRole('button', { name: tab, exact: true }).click();
  await o.waitForTimeout(700);
  await o.screenshot({ path: `${S}/admin-${tab}.png` });
}
// новый товар с ценой
await o.getByRole('button', { name: 'Каталог', exact: true }).click();
await o.getByRole('button', { name: '+ Товар' }).click();
await o.getByLabel('Артикул').fill(`LAB-E${RUN}`);
await o.getByLabel('Название (рус.)').fill(`Чипсы паприка ${RUN}`);
await o.getByLabel('Штрихкоды (через запятую)').fill(`46000${RUN}`);
await o.getByLabel(/Цена на точке/).fill('15');
await o.getByLabel('Причина изменения цены').fill('новый товар');
await o.getByRole('button', { name: 'Сохранить' }).click();
await o.waitForSelector(`text=Чипсы паприка ${RUN}`, { timeout: 10000 });
await o.screenshot({ path: `${S}/admin-catalog-new.png` });
// промо
await o.getByRole('button', { name: 'Промо', exact: true }).click();
await o.getByRole('button', { name: '+ Промокод' }).click();
await o.getByRole('textbox', { name: 'Код' }).fill(`HELLO${RUN}`);
await o.getByRole('textbox', { name: 'Процент' }).fill('5');
await o.getByRole('button', { name: 'Создать' }).click();
await o.waitForSelector(`text=HELLO${RUN}`, { timeout: 10000 });
// журнал содержит изменение цены
await o.getByRole('button', { name: 'Журнал', exact: true }).click();
await o.waitForSelector('text=price.set', { timeout: 10000 });
await o.screenshot({ path: `${S}/admin-audit.png` });

// ---- Витрина: заказ двух пачек чипсов (новый товар без остатка — должен быть «нет в наличии»)
const { p: st } = await mk('http://localhost:5171/store/', { width: 420, height: 860 }, { latitude: 38.561, longitude: 68.79 });
await st.getByRole('button', { name: 'Войти' }).click();
await st.waitForSelector('text=Вафли шоколадные', { timeout: 15000 });
const chips = st.locator('.card', { hasText: `Чипсы паприка ${RUN}` });
await chips.waitFor({ timeout: 10000 });
if (!(await chips.textContent()).includes('нет в наличии')) errors.push('новый товар без остатка показан как доступный');
const waffles = st.locator('.card', { hasText: 'Вафли шоколадные' });
for (let i = 0; i < 3; i++) await waffles.getByRole('button', { name: '+' }).click();
await st.waitForSelector('text=Итого', { timeout: 10000 });
await st.getByRole('button', { name: /Оплатить/ }).click();
await st.waitForSelector('text=Оплачен', { timeout: 15000 });
const num = (await st.locator('h1').textContent()).replace('Заказ ', '').trim();

// ---- Сборщик: задание, отключаем сеть, сканируем, включаем — очередь уходит
const { ctx: pc, p: pk } = await mk('http://localhost:5174/picker/', { width: 420, height: 860 });
await login(pk, '+992900000001');
await pk.waitForSelector(`text=Заказ ${num}`, { timeout: 20000 });
await pc.setOffline(true);
const scan = async (code) => { await pk.keyboard.type(code, { delay: 5 }); await pk.keyboard.press('Enter'); await pk.waitForTimeout(400); };
await scan('A-01-1');
await scan('4600000000011');
await pk.waitForSelector('.numpad', { timeout: 5000 });
await pk.getByRole('button', { name: 'OK' }).click();
await pk.waitForTimeout(2000);

await pk.waitForSelector('text=Нет связи', { timeout: 10000 });
await pk.screenshot({ path: `${S}/picker-offline.png` });
await pc.setOffline(false);
await pk.waitForSelector('text=Завершить сборку', { timeout: 20000 });
await pk.waitForFunction(() => !document.body.innerText.includes('Нет связи'), null, { timeout: 20000 });
await pk.getByRole('button', { name: /Завершить сборку/ }).click();
await pk.waitForSelector(`text=PKG-${num}`, { timeout: 10000 });
await pk.screenshot({ path: `${S}/picker-online-done.png` });

// ---- Пульт: заказ появился готовым без перезагрузки (realtime)
await o.getByRole('button', { name: 'Пульт', exact: true }).click();
await o.waitForSelector(`text=${num}`, { timeout: 15000 });
console.log('order', num);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
