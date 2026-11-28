/**
 * Провайдер подменных номеров (ТЗ §9: звонок через скрытый номер, как в такси). Провайдер не выбран —
 * модуль пишется за интерфейсом, до договора работает StubCallProxy.
 *
 * Модель: на время доставки провайдер связывает настоящие номера курьера и клиента и выдаёт подменные.
 * Курьер набирает numberForCourier — у клиента высвечивается подменный номер, и наоборот.
 * У большинства провайдеров это один номер из пула, маршрут выбирается по номеру звонящего.
 */
export type BindResult = { ok: true; providerRef: string; numberForCourier: string; numberForCustomer: string } | { ok: false; message: string };

export interface CallProxy {
  readonly name: string;
  bind(input: { courierPhone: string; customerPhone: string; ttlSec: number; reference: string }): Promise<BindResult>;
  /** Снять связку: после доставки подменный номер больше никого не соединяет. Повторный вызов безвреден. */
  unbind(providerRef: string): Promise<void>;
}
