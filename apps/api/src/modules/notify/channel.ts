/**
 * Каналы до клиента (ТЗ §10). Контракт DC Next не получен — пуш и SMS за интерфейсом, как кошелёк (ADR-007).
 * Клиент адресуется по dc_user_id: телефона в открытом виде у нас нет, SMS отправляет банк по своему идентификатору.
 */
export type PushResult = { ok: true; delivered: boolean } | { ok: false; error: string };
export type SmsResult = { ok: true } | { ok: false; error: string };

export interface CustomerChannel {
  push(dcUserId: string, msg: { title: string; body: string; orderId: string | null }): Promise<PushResult>;
  sms(dcUserId: string, text: string): Promise<SmsResult>;
}

/** Заглушка: пуш «доставлен», кроме dc_user_id с суффиксом -nopush (для проверки SMS). Всё пишется в лог. */
export class StubChannel implements CustomerChannel {
  readonly sent: { channel: 'push' | 'sms'; dcUserId: string; text: string }[] = [];
  constructor(private readonly log: { info: (o: unknown, m?: string) => void } = console) {}
  async push(dcUserId: string, msg: { title: string; body: string }): Promise<PushResult> {
    this.sent.push({ channel: 'push', dcUserId, text: `${msg.title}\n${msg.body}` });
    this.log.info({ channel: 'push', title: msg.title }, 'notify: пуш (заглушка)');
    return { ok: true, delivered: !dcUserId.endsWith('-nopush') };
  }
  async sms(dcUserId: string, text: string): Promise<SmsResult> {
    this.sent.push({ channel: 'sms', dcUserId, text });
    this.log.info({ channel: 'sms' }, 'notify: SMS (заглушка)');
    return { ok: true };
  }
}
