import { describe, expect, it } from 'vitest';
import { LOCK_MS, WINDOW_MS, afterFailure, isLocked } from './login-guard.js';

const now = new Date('2026-11-27T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('защита PIN от перебора', () => {
  it('блокировка на пятой неудаче в окне', () => {
    let s = null as ReturnType<typeof afterFailure> | null;
    for (let i = 0; i < 4; i++) s = afterFailure(s, at(i * 1000), 5);
    expect(isLocked(s, at(5000))).toBe(false);
    s = afterFailure(s, at(5000), 5);
    expect(isLocked(s, at(6000))).toBe(true);
    expect(isLocked(s, at(5000 + LOCK_MS + 1))).toBe(false);
  });
  it('окно истекло — счёт заново', () => {
    let s = afterFailure(null, now, 5);
    for (let i = 0; i < 3; i++) s = afterFailure(s, at(1000), 5);
    s = afterFailure(s, at(WINDOW_MS + 2000), 5);
    expect(s.failures).toBe(1);
    expect(isLocked(s, at(WINDOW_MS + 3000))).toBe(false);
  });
});
