/**
 * `/v1/studios/me/settings` and `/v1/studios/me/webhooks` routers
 * (issues #759, #760): admin gate, validation, the secret shown once.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { newWebhookSecret } from '../../routes/webhooks.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { StudioSettingsDeps } from '../../routes/studio-settings.js';
import type { WebhooksDeps } from '../../routes/webhooks.js';
import type { StudioSettings, WebhookEndpoint } from '@athlya/shared/schemas/api';

const hoisted = vi.hoisted(() => ({ localResolver: null as JwksKeyResolver | null }));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (hoisted.localResolver === null) throw new Error('local resolver not initialised');
        return hoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const SETTINGS: StudioSettings = {
  name: 'Studio Rive Gauche',
  timezone: 'Europe/Paris',
  addressLine: '12 rue de Seine',
  postalCode: '75006',
  city: 'Paris',
  country: 'FR',
  contactEmail: 'bonjour@rive-gauche.example',
};

const ENDPOINT_ID = '0e000000-0000-4000-8000-000000000001';
const ENDPOINT: WebhookEndpoint = {
  id: ENDPOINT_ID,
  url: 'https://hooks.rive-gauche.fr/athlya',
  events: ['reservation.created'],
  enabled: true,
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
  recentDeliveries: [],
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  hoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function settingsDeps(): StudioSettingsDeps {
  return {
    getSettings: vi.fn<StudioSettingsDeps['getSettings']>().mockResolvedValue(SETTINGS),
    updateSettings: vi
      .fn<StudioSettingsDeps['updateSettings']>()
      .mockImplementation((_claims, patch) =>
        Promise.resolve({ ...SETTINGS, ...(patch as Partial<StudioSettings>) }),
      ),
  };
}

function webhooksDeps(overrides: Partial<WebhooksDeps> = {}): WebhooksDeps {
  return {
    listEndpoints: vi.fn<WebhooksDeps['listEndpoints']>().mockResolvedValue([ENDPOINT]),
    createEndpoint: vi.fn<WebhooksDeps['createEndpoint']>().mockResolvedValue(ENDPOINT),
    updateEndpoint: vi.fn<WebhooksDeps['updateEndpoint']>().mockResolvedValue(ENDPOINT),
    deleteEndpoint: vi.fn<WebhooksDeps['deleteEndpoint']>().mockResolvedValue(true),
    ...overrides,
  };
}

async function call(
  deps: { studioSettings?: StudioSettingsDeps; webhooks?: WebhooksDeps },
  role: 'admin' | 'manager' | 'accueil' | 'coach' | 'member',
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const app = buildApp({ deps: { ...buildStubDeps(), ...deps } });
  const token = await mintAuthJwt(kp, { role });
  return app.request(
    path,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

describe('/v1/studios/me/settings', () => {
  it('serves the settings to an admin only', async () => {
    const studioSettings = settingsDeps();
    const ok = await call({ studioSettings }, 'admin', 'GET', '/v1/studios/me/settings');
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toEqual(SETTINGS);

    for (const role of ['manager', 'accueil', 'coach'] as const) {
      const refused = await call({ studioSettings }, role, 'GET', '/v1/studios/me/settings');
      expect(refused.status).toBe(403);
      const patch = await call({ studioSettings }, role, 'PATCH', '/v1/studios/me/settings', {
        city: 'Lyon',
      });
      expect(patch.status).toBe(403);
    }
    expect(studioSettings.getSettings).toHaveBeenCalledTimes(1);
    expect(studioSettings.updateSettings).not.toHaveBeenCalled();
  });

  it('normalises the patch: empty strings clear, the country is upper-cased', async () => {
    const studioSettings = settingsDeps();
    const res = await call({ studioSettings }, 'admin', 'PATCH', '/v1/studios/me/settings', {
      timezone: 'America/Montreal',
      addressLine: '',
      country: 'ca',
      contactEmail: 'Hello@Example.COM',
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(studioSettings.updateSettings).mock.calls[0]?.[1]).toEqual({
      timezone: 'America/Montreal',
      addressLine: null,
      country: 'CA',
      contactEmail: 'hello@example.com',
    });
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }],
    [{ country: 'France' }],
    [{ contactEmail: 'not-an-email' }],
    [{}],
    [{ slug: 'hijack' }],
  ])('rejects %j with 422', async (body) => {
    const studioSettings = settingsDeps();
    const res = await call({ studioSettings }, 'admin', 'PATCH', '/v1/studios/me/settings', body);
    expect(res.status).toBe(422);
    expect(studioSettings.updateSettings).not.toHaveBeenCalled();
  });
});

describe('/v1/studios/me/webhooks', () => {
  it('creates an endpoint and returns the generated secret once', async () => {
    const webhooks = webhooksDeps();
    const res = await call({ webhooks }, 'admin', 'POST', '/v1/studios/me/webhooks', {
      url: 'https://hooks.rive-gauche.fr/athlya',
      events: ['reservation.created', 'reservation.created'],
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await readJson<{ secret: string }>(res);
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
    const input = vi.mocked(webhooks.createEndpoint).mock.calls[0]?.[1];
    expect(input?.events).toEqual(['reservation.created']);
    expect(input?.secret).toBe(body.secret);
  });

  it.each([
    'http://hooks.rive-gauche.fr/plain',
    'https://127.0.0.1/hook',
    'https://localhost/hook',
    'https://intranet/hook',
    'https://user:pass@hooks.rive-gauche.fr/',
    'https://hooks.studio.local/x',
    'https://[::1]/x',
  ])('refuses the endpoint URL %s', async (url) => {
    const webhooks = webhooksDeps();
    const res = await call({ webhooks }, 'admin', 'POST', '/v1/studios/me/webhooks', {
      url,
      events: ['reservation.created'],
    });
    expect(res.status).toBe(422);
    expect(webhooks.createEndpoint).not.toHaveBeenCalled();
  });

  it('answers 409 at the endpoint limit and 404 for an unknown endpoint', async () => {
    const webhooks = webhooksDeps({
      createEndpoint: vi.fn<WebhooksDeps['createEndpoint']>().mockResolvedValue(null),
      updateEndpoint: vi.fn<WebhooksDeps['updateEndpoint']>().mockResolvedValue(null),
      deleteEndpoint: vi.fn<WebhooksDeps['deleteEndpoint']>().mockResolvedValue(false),
    });
    const create = await call({ webhooks }, 'admin', 'POST', '/v1/studios/me/webhooks', {
      url: 'https://hooks.rive-gauche.fr/a',
      events: ['reservation.cancelled'],
    });
    expect(create.status).toBe(409);
    expect(
      (
        await call({ webhooks }, 'admin', 'PATCH', `/v1/studios/me/webhooks/${ENDPOINT_ID}`, {
          enabled: false,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ webhooks }, 'admin', 'DELETE', `/v1/studios/me/webhooks/${ENDPOINT_ID}`))
        .status,
    ).toBe(404);
  });

  it('rotates the secret and passes the new one to the adapter', async () => {
    const webhooks = webhooksDeps();
    const res = await call(
      { webhooks },
      'admin',
      'POST',
      `/v1/studios/me/webhooks/${ENDPOINT_ID}/rotate-secret`,
    );
    expect(res.status).toBe(200);
    const { secret } = await readJson<{ secret: string }>(res);
    expect(webhooks.updateEndpoint).toHaveBeenCalledWith(expect.anything(), ENDPOINT_ID, {
      secret,
    });
  });

  it('lists the endpoints without any secret, to an admin only', async () => {
    const webhooks = webhooksDeps();
    const res = await call({ webhooks }, 'admin', 'GET', '/v1/studios/me/webhooks');
    expect(res.status).toBe(200);
    expect(JSON.stringify(await readJson(res))).not.toContain('whsec_');
    for (const role of ['manager', 'accueil', 'coach'] as const) {
      expect((await call({ webhooks }, role, 'GET', '/v1/studios/me/webhooks')).status).toBe(403);
    }
    expect(webhooks.listEndpoints).toHaveBeenCalledTimes(1);
  });

  it('generates distinct secrets', () => {
    expect(newWebhookSecret()).not.toBe(newWebhookSecret());
  });
});
