import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());

describe('/metrics (ТЗ §10)', () => {
  it('отдаёт счётчики HTTP, гистограмму и метрики очередей и денег', async () => {
    await ctx.app.inject({ method: 'GET', url: '/api/v1/orders/00000000-0000-0000-0000-000000000000' });
    const r = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('dark_http_requests_total{route="/api/v1/orders/:id",method="GET",status="4xx"} 1');
    expect(r.body).toContain('dark_http_request_duration_seconds_bucket{route="/api/v1/orders/:id",method="GET",le="+Inf"} 1');
    for (const m of ['dark_outbox_backlog', 'dark_outbox_oldest_seconds', 'dark_payments_pending_over_5m', 'dark_holds_failed_10m']) expect(r.body).toContain(`${m} `);
  });
});
