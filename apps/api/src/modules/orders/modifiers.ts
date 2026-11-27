import { DishModifiers, type ModifierSelection, type ModifierSnapshot } from '@dark/contracts';
import type { Dirams } from '../../shared/money.js';

/** Разбор модификаторов из БД: старые записи ({}) и мусор — это «без модификаторов». */
export function parseDishModifiers(raw: unknown): DishModifiers {
  const r = DishModifiers.safeParse(raw ?? {});
  return r.success ? r.data : { groups: [] };
}

/**
 * Проверка выбора клиента и доплата (ТЗ §2). Чистая функция: сервер не доверяет цене с клиента.
 * Правила: только известные группы и варианты, без повторов, в каждой группе min ≤ выбрано ≤ max.
 */
export function applyModifiers(def: DishModifiers, sel: ModifierSelection | undefined): { extra: Dirams; snapshot: ModifierSnapshot } | { error: string } {
  const chosen = sel ?? {};
  for (const gid of Object.keys(chosen)) if (!def.groups.some((g) => g.id === gid)) return { error: `неизвестная группа ${gid}` };
  let extra = 0;
  const snapshot: ModifierSnapshot = [];
  for (const g of def.groups) {
    const ids = chosen[g.id] ?? [];
    if (new Set(ids).size !== ids.length) return { error: `повтор варианта в группе «${g.name}»` };
    if (ids.length < g.min) return { error: `в группе «${g.name}» нужно выбрать минимум ${g.min}` };
    if (ids.length > g.max) return { error: `в группе «${g.name}» можно выбрать максимум ${g.max}` };
    const opts = [];
    for (const id of ids) {
      const o = g.options.find((x) => x.id === id);
      if (!o) return { error: `неизвестный вариант ${id} в группе «${g.name}»` };
      extra += o.price_dirams;
      opts.push({ name: o.name, price_dirams: o.price_dirams });
    }
    if (opts.length) snapshot.push({ group: g.name, options: opts });
  }
  return { extra, snapshot };
}
