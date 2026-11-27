import { describe, expect, it } from 'vitest';
import pino from 'pino';
import Fastify from 'fastify';
import { loggerOptions, scrubUrl } from './logger.js';

describe('логи без секретов (ТЗ §10)', () => {
  it('scrubUrl убирает token, dc_token, pin из строки запроса', () => {
    expect(scrubUrl('/api/v1/ws?token=a.b.c&store_id=1')).toBe('/api/v1/ws?token=[redacted]&store_id=1');
    expect(scrubUrl('/x?store_id=1&TOKEN=zzz#h')).toBe('/x?store_id=1&TOKEN=[redacted]#h');
    expect(scrubUrl('/x?dc_token=1&pin=1234')).toBe('/x?dc_token=[redacted]&pin=[redacted]');
    expect(scrubUrl('/api/v1/catalog?q=token')).toBe('/api/v1/catalog?q=token');
  });

  it('журнал запросов Fastify не содержит JWT из ?token=', async () => {
    const lines: string[] = [];
    const app = Fastify({ loggerInstance: pino(loggerOptions('info', false), { write: (s: string) => void lines.push(s) }) });
    app.get('/api/v1/ws', async () => 'ok');
    await app.inject({ method: 'GET', url: '/api/v1/ws?token=SECRET.JWT.VALUE&store_id=1', headers: { authorization: 'Bearer SECRET2' } });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('/api/v1/ws?token=[redacted]&store_id=1');
    expect(all).not.toContain('SECRET');
  });
});
