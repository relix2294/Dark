import { z } from 'zod';

/**
 * Деньги — всегда целые дирамы (1 сомони = 100 дирам). Никаких float (ТЗ §1).
 * Тип в контракте — просто целое; арифметика живёт в @dark/api shared/money.
 */
export const Dirams = z.number().int().min(0).describe('Сумма в дирамах, 1 сомони = 100 дирам');
export type Dirams = z.infer<typeof Dirams>;

export const Qty = z.number().int().min(0);
export type Qty = z.infer<typeof Qty>;
