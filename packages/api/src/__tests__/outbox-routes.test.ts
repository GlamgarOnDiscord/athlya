import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOutboxRouter,
  OUTBOX_PENDING_ALERT_THRESHOLD,
} from '../admin/outbox-routes.js';

import type { OutboxAdminEnv } from '../admin/outbox-routes.js';

const withTenantTxMock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/tenant.js', () => ({
  withTenantTx: withTenantTxMock,
}));

type Role = 'member' | 'admin' | 'coach';

function buildApp(role: Role | null) {
  const app = new Hono<OutboxAdminEnv>();

  app.use('*', async (c, next) => {
    c.set('traceId', 'trace-outbox-test');
    if (role !== null) {
      c.set('authClaims', {
        userId: '00000000-0000-4000-8000-000000000001',
        studioId: '00000000-0000-4000-8000-000000000002',
        role,
      });
    }
    await next();
  });

  app.route('/', buildOutboxRouter());

  const env = { DB_URL: 'postgresql://test@localhost/test' } as OutboxAdminEnv['Bindings'];
  return { app, env };
}

describe('GET /admin/outbox/stats', () => {
  beforeEach(() => {
    withTenantTxMock.mockReset();
    withTenantTxMock.mockResolvedValue({
      pending: 12,
      oldestOccurredAt: new Date('2025-06-01T10:00:00.000Z'),
    });
  });

  it('returns 403 without auth claims', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request('/admin/outbox/stats', { method: 'GET' }, env);
    expect(res.status).toBe(403);
  });

  it('returns 403 for member role', async () => {
    const { app, env } = buildApp('member');
    const res = await app.request('/admin/outbox/stats', { method: 'GET' }, env);
    expect(res.status).toBe(403);
  });

  it('returns pending snapshot for admin', async () => {
    const { app, env } = buildApp('admin');
    const res = await app.request('/admin/outbox/stats', { method: 'GET' }, env);
    expect(res.status).toBe(200);

    const body = await res.json<{
      pending: number;
      oldestPendingOccurredAt: string;
      alertThreshold: number;
      backlogAlertRecommended: boolean;
    }>();
    expect(body.pending).toBe(12);
    expect(body.oldestPendingOccurredAt).toBe('2025-06-01T10:00:00.000Z');
    expect(body.alertThreshold).toBe(OUTBOX_PENDING_ALERT_THRESHOLD);
    expect(body.backlogAlertRecommended).toBe(false);
  });

  it('flags backlogAlertRecommended above threshold', async () => {
    withTenantTxMock.mockResolvedValue({
      pending: OUTBOX_PENDING_ALERT_THRESHOLD + 1,
      oldestOccurredAt: null,
    });
    const { app, env } = buildApp('admin');
    const res = await app.request('/admin/outbox/stats', { method: 'GET' }, env);
    const body = await res.json<{ backlogAlertRecommended: boolean }>();
    expect(body.backlogAlertRecommended).toBe(true);
  });
});
