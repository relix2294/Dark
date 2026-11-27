import { AppError } from './errors/index.js';

/**
 * Общая машина состояний: таблица переходов + проверка.
 * Переход вне таблицы → 409 INVALID_TRANSITION (ТЗ §3).
 */
export class StateMachine<S extends string, A extends string = string> {
  private readonly allowed = new Map<string, Set<A>>();

  constructor(
    private readonly entity: string,
    transitions: ReadonlyArray<{ from: S | readonly S[]; to: S; by: readonly A[] }>,
  ) {
    for (const t of transitions) {
      const froms = Array.isArray(t.from) ? (t.from as readonly S[]) : [t.from as S];
      for (const f of froms) this.allowed.set(`${f}->${t.to}`, new Set(t.by));
    }
  }

  can(from: S, to: S, by?: A): boolean {
    const actors = this.allowed.get(`${from}->${to}`);
    if (!actors) return false;
    return by === undefined || actors.has(by);
  }

  assert(from: S, to: S, by: A): void {
    if (!this.allowed.has(`${from}->${to}`)) {
      throw new AppError('INVALID_TRANSITION', `${this.entity}: переход ${from} → ${to} запрещён`, {
        entity: this.entity,
        from,
        to,
      });
    }
    if (!this.can(from, to, by)) {
      throw new AppError('FORBIDDEN', `${this.entity}: переход ${from} → ${to} недоступен для ${by}`, {
        entity: this.entity,
        from,
        to,
        actor: by,
      });
    }
  }
}
