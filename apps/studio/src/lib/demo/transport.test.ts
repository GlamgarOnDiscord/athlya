import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDemoTransport, isDemoRequest } from './transport';

const PAGE = 'https://athlya-studio.vercel.app';
const API = 'https://athlya-api.invalid';

describe('isDemoRequest', () => {
  it('routes every API origin request to the fake', () => {
    expect(isDemoRequest(new URL(`${API}/v1/classes?from=x`), PAGE, API)).toBe(true);
    expect(isDemoRequest(new URL(`${API}/anything`), PAGE, API)).toBe(true);
  });

  it('routes the BFF auth routes and same-origin API paths to the fake', () => {
    expect(isDemoRequest(new URL(`${PAGE}/api/auth/refresh`), PAGE, API)).toBe(true);
    expect(isDemoRequest(new URL(`${PAGE}/v1/members/me`), PAGE, null)).toBe(true);
  });

  it('lets page, RSC and asset requests through', () => {
    expect(isDemoRequest(new URL(`${PAGE}/classes?_rsc=1`), PAGE, API)).toBe(false);
    expect(isDemoRequest(new URL(`${PAGE}/_next/static/chunk.js`), PAGE, API)).toBe(false);
    expect(isDemoRequest(new URL('https://challenges.cloudflare.com/turnstile'), PAGE, API)).toBe(
      false,
    );
  });

  it('never matches another origin path that merely looks like the API', () => {
    expect(isDemoRequest(new URL('https://evil.example/v1/members/me'), PAGE, API)).toBe(false);
  });
});

describe('installDemoTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers API calls in memory and leaves other requests to the network', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_API_URL', API);
    const network = vi.fn(() => Promise.resolve(new Response('page')));
    vi.stubGlobal('fetch', network);
    installDemoTransport();

    const refresh = await window.fetch('/api/auth/refresh', { method: 'POST' });
    expect(refresh.status).toBe(401);
    const api = await window.fetch(`${API}/v1/classes`);
    expect(api.status).toBe(401);
    expect(network).not.toHaveBeenCalled();

    const page = await window.fetch('/classes');
    expect(await page.text()).toBe('page');
    expect(network).toHaveBeenCalledTimes(1);
  });
});
