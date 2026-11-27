/**
 * Деньги — целые дирамы. 1 сомони = 100 дирам. Никаких float (ТЗ §1).
 * Процентные операции округляются по правилу «половина вверх» на уровне дирама.
 */
export type Dirams = number;

export function assertDirams(v: unknown, name = 'amount'): asserts v is Dirams {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new TypeError(`${name} должен быть целым неотрицательным числом дирамов, получено ${String(v)}`);
  }
}

export const sum = (xs: readonly Dirams[]): Dirams => xs.reduce((a, b) => a + b, 0);

/** qty × price. Для весового товара qty — граммы, price — за 1000 г. */
export function lineTotal(price: Dirams, qty: number, isWeighted = false): Dirams {
  assertDirams(price, 'price');
  if (!Number.isInteger(qty) || qty < 0) throw new TypeError('qty должно быть целым');
  if (!isWeighted) return price * qty;
  // вес в граммах, цена за килограмм
  return Math.round((price * qty) / 1000);
}

/** amount × pct / 100 с округлением до дирама. */
export function percentOf(amount: Dirams, pct: number): Dirams {
  assertDirams(amount);
  if (pct < 0) throw new TypeError('pct < 0');
  return Math.round((amount * pct) / 100);
}

/** total = items + fee − discount, скидка не может превысить items + fee (ТЗ §2 инвариант). */
export function orderTotal(items: Dirams, fee: Dirams, discount: Dirams): Dirams {
  assertDirams(items, 'items');
  assertDirams(fee, 'fee');
  assertDirams(discount, 'discount');
  const base = items + fee;
  if (discount > base) throw new RangeError('discount превышает items + fee');
  return base - discount;
}

/** Сумма холда: заказ + буфер на весовой товар (ТЗ §5 п.5). */
export function holdAmount(total: Dirams, hasWeighted: boolean, bufferPct: number): Dirams {
  assertDirams(total, 'total');
  return hasWeighted ? total + percentOf(total, bufferPct) : total;
}

export const toSomoni = (d: Dirams): string => `${Math.floor(d / 100)}.${String(d % 100).padStart(2, '0')}`;
