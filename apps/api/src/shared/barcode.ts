/**
 * EAN-13: контрольная цифра и внутренние коды. Префикс 200–299 — диапазон для внутреннего использования магазином,
 * такие коды не пересекаются с кодами производителей (ТЗ §7: «товар без штрихкода получает внутренний»).
 */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('нужно 12 цифр');
  const sum = [...first12].reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** 200 + 9 цифр номера + контрольная. */
export function internalEan13(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999) throw new Error('номер вне диапазона');
  const body = `200${String(seq).padStart(9, '0')}`;
  return body + ean13CheckDigit(body);
}
