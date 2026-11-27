#!/usr/bin/env node
/**
 * Проверка границ модулей (ТЗ §1: модули общаются через внутренние интерфейсы, не через чужие таблицы).
 * Правила:
 *  1. modules/X/** может импортировать из modules/Y только `../Y/index.js` (публичный интерфейс).
 *  2. shared/** не импортирует из modules/**.
 *  3. Схему БД читать может любой модуль (отчёты, представления).
 *  4. Писать (insert/update/delete) в таблицу может только её владелец из OWNERSHIP.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'apps', 'api', 'src');

/** Какому модулю принадлежат таблицы (запись — только владелец). */
export const OWNERSHIP = {
  catalog: ['store', 'deliveryZone', 'category', 'product', 'price', 'dish'],
  customers: ['customer', 'address', 'userStaff', 'authAttempt'],
  orders: ['order', 'orderItem', 'orderStatusLog', 'orderRating'],
  payments: ['payment', 'paymentOp'],
  promo: ['promo', 'promoUse'],
  wms: ['cell', 'supply', 'supplyItem', 'stockLot', 'stockMove', 'stocktake', 'stocktakeLine', 'pickTask'],
  kds: ['kdsItem', 'stopList'],
  dispatch: ['courier', 'courierShift', 'courierPosition', 'deliveryTask', 'courierPlan'],
  backoffice: ['parameter', 'devicePresence'],
  notify: ['notification'],
  shared: ['outbox', 'idempotencyKey', 'auditLog'],
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const importRe = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm;
const writeRe = /\.(insert|update|delete)\(\s*(\w+)\s*\)/g;
const owner = new Map(Object.entries(OWNERSHIP).flatMap(([mod, tables]) => tables.map((t) => [t, mod])));
const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  const inModule = rel.match(/^modules\/([^/]+)\//)?.[1] ?? null;
  const inShared = rel.startsWith('shared/');

  // 4. Запись в таблицу — только модулем-владельцем (shared/* пишет только свои таблицы; seed — исключение)
  const writer = inModule ?? (inShared ? 'shared' : null);
  if (writer && !rel.endsWith('seed.ts')) {
    for (const m of src.matchAll(writeRe)) {
      const table = m[2];
      const tableOwner = owner.get(table);
      if (tableOwner && tableOwner !== writer) {
        const line = src.slice(0, m.index).split('\n').length;
        violations.push(`${rel}:${line}: ${m[1]}(${table}) — таблица модуля ${tableOwner}; вызовите функцию из его index.ts`);
      }
    }
  }

  for (const m of src.matchAll(importRe)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const target = relative(ROOT, resolve(dirname(file), spec)).split(sep).join('/');
    const targetModule = target.match(/^modules\/([^/]+)(?:\/(.*))?$/);
    if (inShared && targetModule) violations.push(`${rel}: shared не должен импортировать modules (${spec})`);
    if (inModule && targetModule && targetModule[1] !== inModule) {
      const inner = targetModule[2] ?? '';
      if (inner !== 'index.js' && inner !== 'index' && inner !== '') {
        violations.push(`${rel}: импорт внутренностей модуля ${targetModule[1]} (${spec}); используйте ../${targetModule[1]}/index.js`);
      }
    }
  }
}

if (violations.length) {
  console.error('Нарушения границ модулей:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log('Границы модулей соблюдены.');
