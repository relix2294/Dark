import { z } from 'zod';
import { Dirams } from './money.js';

/**
 * Модификаторы блюд Sor Box (ТЗ §2 dish.modifiers, order_item.modifiers): группы с вариантами и доплатой.
 * Пример: «Размер» (ровно 1 из 25/30/35 см), «Добавки» (0–3 из сыр/грибы/халапеньо).
 */
export const ModifierOption = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  price_dirams: Dirams.default(0),
});
export const ModifierGroup = z
  .object({
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(60),
    min: z.number().int().min(0).default(0),
    max: z.number().int().min(1).default(1),
    options: z.array(ModifierOption).min(1).max(30),
  })
  .refine((g) => g.min <= g.max, { message: 'min больше max' })
  .refine((g) => g.max <= g.options.length, { message: 'max больше числа вариантов' });
export const DishModifiers = z.object({ groups: z.array(ModifierGroup).max(10).default([]) });
export type DishModifiers = z.infer<typeof DishModifiers>;

/** Выбор клиента: id группы → id вариантов. */
export const ModifierSelection = z.record(z.string(), z.array(z.string()).max(30));
export type ModifierSelection = z.infer<typeof ModifierSelection>;

/** Снимок выбора в позиции заказа: названия и цены на момент заказа — для кухни, чека и истории. */
export const ModifierSnapshot = z.array(z.object({ group: z.string(), options: z.array(z.object({ name: z.string(), price_dirams: Dirams })) }));
export type ModifierSnapshot = z.infer<typeof ModifierSnapshot>;
