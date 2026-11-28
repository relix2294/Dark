import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { isConnectivityError } from './offline.js';

describe('обрыв связи или ответ сервера', () => {
  it('нет сети и ошибки шлюза — обрыв; ответы API с кодом — нет', () => {
    expect(isConnectivityError(new ApiError(0, 'NETWORK', 'x'))).toBe(true);
    expect(isConnectivityError(new ApiError(502, 'INTERNAL', 'HTTP 502'))).toBe(true);
    expect(isConnectivityError(new ApiError(503, 'CALL_UNAVAILABLE', 'звонок недоступен'))).toBe(false);
    expect(isConnectivityError(new ApiError(409, 'INVALID_TRANSITION', 'x'))).toBe(false);
    expect(isConnectivityError(new ApiError(500, 'INTERNAL', 'x'))).toBe(false);
  });
});
