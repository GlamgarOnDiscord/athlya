/**
 * `GET /v1/auth/turnstile-challenge` — the page the mobile app loads in a
 * WebView to solve Cloudflare Turnstile (issue #649).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TURNSTILE_DEV_TEST_SITE_KEY,
  buildChallengeCsp,
  createNonce,
  parseChallengeLocale,
  parseChallengeTheme,
  renderChallengePage,
  resolveSiteKey,
  turnstileChallengeHandler,
} from '../../routes/turnstile-challenge.js';
import { readJson } from '../helpers/read-json.js';

import { buildStubDeps, buildTestApp, env } from './route-test-helpers.js';

import type { StructuredLogger } from '../../logging.js';
import type { HonoEnv } from '../../types.js';

const SITE_KEY = '0x4AAAAAAATestSiteKey_-';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The handler alone, for staging / production bindings: the full app's
 * host check and Redis-backed limiters are covered by their own suites.
 */
function handlerApp() {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('traceId', 'trace-1');
    c.set('logger', logger as unknown as StructuredLogger);
    await next();
  });
  app.get('/challenge', (c) => turnstileChallengeHandler(c));
  return { app, logger };
}

function nonceOf(csp: string): string {
  const match = /'nonce-([^']+)'/u.exec(csp);
  if (match?.[1] === undefined) throw new Error(`no nonce in ${csp}`);
  return match[1];
}

describe('GET /v1/auth/turnstile-challenge', () => {
  it('serves the widget page with the configured site key and a strict CSP', async () => {
    const app = buildTestApp(buildStubDeps());
    const res = await app.request(
      '/v1/auth/turnstile-challenge?lang=en&theme=dark',
      { method: 'GET' },
      env({ TURNSTILE_SITE_KEY: SITE_KEY }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = nonceOf(csp);
    expect(csp).toBe(buildChallengeCsp(nonce));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");

    const html = await res.text();
    expect(html).toContain(`data-site-key="${SITE_KEY}"`);
    expect(html).toContain('data-language="en"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain('window.ReactNativeWebView');
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  });

  it('never sends the Turnstile secret to the client', async () => {
    const app = buildTestApp(buildStubDeps());
    const secret = '0x4AAAAAAATopSecretValue';
    const res = await app.request(
      '/v1/auth/turnstile-challenge',
      { method: 'GET' },
      env({ TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET: secret }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(secret);
    for (const value of res.headers.values()) expect(value).not.toContain(secret);
  });

  it('uses a fresh nonce on every response', async () => {
    const app = buildTestApp(buildStubDeps());
    const bindings = env({ TURNSTILE_SITE_KEY: SITE_KEY });
    const first = await app.request('/v1/auth/turnstile-challenge', { method: 'GET' }, bindings);
    const second = await app.request('/v1/auth/turnstile-challenge', { method: 'GET' }, bindings);
    expect(nonceOf(first.headers.get('content-security-policy') ?? '')).not.toBe(
      nonceOf(second.headers.get('content-security-policy') ?? ''),
    );
  });

  it('defaults to French and the automatic theme for unknown query values', async () => {
    const app = buildTestApp(buildStubDeps());
    const res = await app.request(
      '/v1/auth/turnstile-challenge?lang=%22%3E%3Cscript%3E&theme=%3Cx%3E',
      { method: 'GET' },
      env({ TURNSTILE_SITE_KEY: SITE_KEY }),
    );
    const html = await res.text();
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('data-theme="auto"');
    expect(html).not.toContain('<x>');
  });

  it('answers 500 configuration_error outside dev when the site key is missing', async () => {
    const { app, logger } = handlerApp();
    const res = await app.request(
      '/challenge',
      { method: 'GET' },
      env({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await readJson<{ code: string; status: number; traceId: string }>(res);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      traceId: 'trace-1',
      code: 'configuration_error',
    });
    expect(logger.error).toHaveBeenCalledWith('turnstile site key missing or invalid', {
      environment: 'production',
    });
  });

  it('answers 500 when the configured site key is malformed', async () => {
    const { app } = handlerApp();
    const res = await app.request(
      '/challenge',
      { method: 'GET' },
      env({ ENVIRONMENT: 'staging', TURNSTILE_SITE_KEY: '"><script>alert(1)</script>' }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('<script>');
  });

  it('serves the page in production with the configured key', async () => {
    const { app } = handlerApp();
    const res = await app.request(
      '/challenge',
      { method: 'GET' },
      env({ ENVIRONMENT: 'production', TURNSTILE_SITE_KEY: SITE_KEY }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`data-site-key="${SITE_KEY}"`);
  });

  it("falls back to Cloudflare's always-pass test key in dev", async () => {
    const app = buildTestApp(buildStubDeps());
    const res = await app.request('/v1/auth/turnstile-challenge', { method: 'GET' }, env());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`data-site-key="${TURNSTILE_DEV_TEST_SITE_KEY}"`);
  });

  it('does not open a path around Turnstile on login', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);
    const bindings = env({
      TURNSTILE_SITE_KEY: SITE_KEY,
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    });
    await app.request('/v1/auth/turnstile-challenge', { method: 'GET' }, bindings);
    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', password: 'hunter22' }),
      },
      bindings,
    );
    expect(res.status).toBe(403);
    expect(deps.auth.login).not.toHaveBeenCalled();
  });
});

describe('challenge page helpers', () => {
  it('only accepts the supported locales and themes', () => {
    expect(parseChallengeLocale('en')).toBe('en');
    expect(parseChallengeLocale('fr')).toBe('fr');
    expect(parseChallengeLocale('de')).toBe('fr');
    expect(parseChallengeLocale(undefined)).toBe('fr');
    expect(parseChallengeTheme('light')).toBe('light');
    expect(parseChallengeTheme('dark')).toBe('dark');
    expect(parseChallengeTheme('neon')).toBe('auto');
  });

  it('resolves the site key per environment', () => {
    expect(resolveSiteKey({ ENVIRONMENT: 'production', TURNSTILE_SITE_KEY: SITE_KEY })).toBe(
      SITE_KEY,
    );
    expect(resolveSiteKey({ ENVIRONMENT: 'staging', TURNSTILE_SITE_KEY: `  ${SITE_KEY} ` })).toBe(
      SITE_KEY,
    );
    expect(resolveSiteKey({ ENVIRONMENT: 'production' })).toBeNull();
    expect(resolveSiteKey({ ENVIRONMENT: 'preview', TURNSTILE_SITE_KEY: '' })).toBeNull();
    expect(resolveSiteKey({ ENVIRONMENT: 'dev' })).toBe(TURNSTILE_DEV_TEST_SITE_KEY);
    expect(resolveSiteKey({ ENVIRONMENT: 'dev', TURNSTILE_SITE_KEY: 'bad key' })).toBeNull();
  });

  it('allows only challenges.cloudflare.com besides the nonce', () => {
    const csp = buildChallengeCsp('abc');
    const sources = csp
      .split(';')
      .flatMap((directive) => directive.trim().split(/\s+/u).slice(1))
      .filter((source) => source.startsWith('http'));
    expect(new Set(sources)).toEqual(new Set(['https://challenges.cloudflare.com']));
  });

  it('creates base64 nonces of 16 bytes', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
  });

  it('refuses to render an invalid site key', () => {
    expect(() =>
      renderChallengePage({ siteKey: '<x>', nonce: 'n', locale: 'fr', theme: 'auto' }),
    ).toThrow('invalid Turnstile site key');
  });
});
