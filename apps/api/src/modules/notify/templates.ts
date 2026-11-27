import { formatLocal } from '../../shared/time.js';
import { toSomoni } from '../../shared/money.js';

/**
 * Тексты уведомлений клиенту по таблице ТЗ §10. Чистые функции: событие → заголовок и текст.
 * Время — по Душанбе, деньги — в сомони. Номера телефонов и данные кошелька в текст не попадают.
 */
export type Kind = 'accepted' | 'item_changed' | 'courier_left' | 'delayed' | 'delivered' | 'cancelled' | 'refunded';

/** Для этих при недоставленном за 30 с пуше уходит SMS (ТЗ §10). */
export const SMS_FALLBACK: ReadonlySet<Kind> = new Set(['courier_left', 'cancelled']);

const t = (d: Date) => formatLocal(d).split(', ').pop()!; // «14:35»
const brand = (b: string) => (b === 'SOR' ? 'Sor Box' : 'Lablabu');

export type Msg = { title: string; body: string };

export const render = {
  accepted: (o: { number: string; brand: string; promisedAt: Date | null }): Msg => ({
    title: `${brand(o.brand)}: заказ ${o.number} принят`,
    body: o.promisedAt ? `Доставим к ${t(o.promisedAt)}.` : 'Скоро начнём собирать.',
  }),
  itemChanged: (o: { number: string; totalDirams: number }, change: { name: string; status: 'missing' | 'replaced'; replacement?: string | undefined }): Msg => ({
    title: change.status === 'replaced' ? `Заказ ${o.number}: замена` : `Заказ ${o.number}: товара нет`,
    body:
      change.status === 'replaced' && change.replacement
        ? `«${change.name}» заменили на «${change.replacement}». Новая сумма ${toSomoni(o.totalDirams)} с.`
        : `«${change.name}» закончился, убрали из заказа. Новая сумма ${toSomoni(o.totalDirams)} с.`,
  }),
  courierLeft: (o: { number: string; promisedAt: Date | null }, courierName: string | null, trackUrl: string): Msg => ({
    title: `Заказ ${o.number} в пути`,
    body: `${courierName ? `Курьер ${courierName}` : 'Курьер'} выехал${o.promisedAt ? `, будет к ${t(o.promisedAt)}` : ''}. Где он: ${trackUrl}`,
  }),
  delayed: (o: { number: string }, newEta: Date): Msg => ({
    title: `Заказ ${o.number} задерживается`,
    body: `Простите, не успеваем к обещанному времени. Новое время — около ${t(newEta)}.`,
  }),
  delivered: (o: { number: string; capturedDirams: number | null; totalDirams: number }, receiptUrl: string): Msg => ({
    title: `Заказ ${o.number} доставлен`,
    body: `Списано ${toSomoni(o.capturedDirams ?? o.totalDirams)} с. Чек: ${receiptUrl}. Оцените доставку — это займёт секунду.`,
  }),
  cancelled: (o: { number: string; cancelReason: string | null; capturedDirams: number | null }): Msg => ({
    title: `Заказ ${o.number} отменён`,
    body: `${o.cancelReason ? `Причина: ${o.cancelReason}. ` : ''}${
      o.capturedDirams ? `Удержано ${toSomoni(o.capturedDirams)} с за уже приготовленное.` : 'Деньги не списаны, блокировка на карте снята.'
    }`,
  }),
  refunded: (o: { number: string }, amountDirams: number, reason: string | null): Msg => ({
    title: `Возврат по заказу ${o.number}`,
    body: `Вернули ${toSomoni(amountDirams)} с${reason ? `: ${reason}` : ''}. Деньги придут в кошелёк DC.`,
  }),
};
