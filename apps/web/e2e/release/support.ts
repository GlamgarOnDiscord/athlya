/**
 * Shared helpers for the post-deploy release smoke (issue #422).
 *
 * The release specs drive the deployed web Worker against the real API:
 * no `page.route()` stubs, no local server. Configuration comes from the
 * environment and is validated by `e2e/release.config.ts` before any test
 * runs, so a release run with a missing credential fails instead of
 * skipping.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';

/**
 * `full` drives every flow, including the `@turnstile` ones that log in or
 * submit a Turnstile-protected form. `public` only drives anonymous pages:
 * it is the production scope, because the production Turnstile secret is
 * real and single-use (docs/runbooks/canary-deploy.md).
 */
export type ReleaseScope = 'full' | 'public';

/** No default: a run that forgets the scope must not pick one silently. */
export function releaseScope(): ReleaseScope {
  const raw = process.env['RELEASE_SMOKE_SCOPE'];
  if (raw !== 'full' && raw !== 'public') {
    throw new Error(`RELEASE_SMOKE_SCOPE must be "full" or "public", got "${raw ?? ''}"`);
  }
  return raw;
}

/**
 * Reads required variables, failing with every missing name at once.
 * Only `*_URL` values are normalised (trimmed, trailing slashes removed);
 * credentials are returned exactly as configured.
 */
export function requireEnv<const K extends string>(names: readonly K[]): Record<K, string> {
  const missing = names.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    throw new Error(`Release smoke: missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(
    names.map((name) => {
      const value = process.env[name] ?? '';
      return [name, name.endsWith('_URL') ? value.trim().replace(/\/+$/u, '') : value];
    }),
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

/** The cookie banner sits over the forms; refuse optional cookies if it shows. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /tout refuser|refuse all/i })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
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
