/**
 * Shared helpers for the studio post-deploy release smoke (issue #422).
 * Mirrors `apps/web/e2e/release/support.ts`: the release specs drive the
 * deployed studio Worker against the real API, with no `page.route()`
 * stubs, and `e2e/release.config.ts` validates the environment first.
 */
import { expect, type Locator, type Response } from '@playwright/test';

/**
 * `full` drives every flow, including the `@turnstile` admin login.
 * `public` only drives anonymous pages: it is the production scope,
 * because the production Turnstile secret is real and single-use
 * (docs/runbooks/canary-deploy.md).
 */
export type ReleaseScope = 'full' | 'public';

export function releaseScope(): ReleaseScope {
  const raw = process.env['RELEASE_SMOKE_SCOPE'] ?? 'full';
  if (raw !== 'full' && raw !== 'public') {
    throw new Error(`RELEASE_SMOKE_SCOPE must be "full" or "public", got "${raw}"`);
  }
  return raw;
}

/** Reads required variables, failing with every missing name at once. */
export function requireEnv<const K extends string>(names: readonly K[]): Record<K, string> {
  const missing = names.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    throw new Error(`Release smoke: missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(
    names.map((name) => [name, (process.env[name] ?? '').trim().replace(/\/+$/u, '')]),
  ) as Record<K, string>;
}

/** Tag that keeps per-run data apart across GitHub runs, attempts and retries. */
export function runTag(retry: number): string {
  const run = process.env['GITHUB_RUN_ID'] ?? String(Date.now());
  const attempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1';
  return `${run}-${attempt}-${String(retry)}`;
}

/** Matches a response by method and URL pathname, on any origin. */
export function isCall(method: string, pathname: string | RegExp) {
  return (response: Response): boolean => {
    if (response.request().method() !== method) return false;
    const { pathname: actual } = new URL(response.url());
    return typeof pathname === 'string' ? actual === pathname : pathname.test(actual);
  };
}

/**
 * Turnstile keeps the submit button disabled until it issues a token.
 * Staging must run Cloudflare's test keys so a headless browser passes.
 */
export async function waitForSubmittable(button: Locator): Promise<void> {
  await expect(
    button,
    'submit stayed disabled: Turnstile issued no token (staging needs the Turnstile test keys)',
  ).toBeEnabled({ timeout: 30_000 });
}
