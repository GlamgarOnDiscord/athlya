/**
 * Build-time switch of the demo mode (issue #750).
 *
 * `NEXT_PUBLIC_DEMO_MODE=1` builds the app against an in-memory fake API
 * (`./fake-api.ts`) so the Vercel test projects can be clicked through
 * without a backend. `next.config.ts` calls {@link resolveDemoMode} once
 * and re-exports the result through Next `env`, which turns every
 * `process.env.NEXT_PUBLIC_DEMO_MODE === '1'` check into a compile-time
 * constant: a normal build drops the demo branches and never bundles the
 * fixtures.
 *
 * The flag can never reach production: the build throws when it is on
 * and either `APP_ENV` is `production` or the API origin is the
 * production one.
 */

/** Hostname of the production API (`deploy-production.yml`). */
export const PRODUCTION_API_HOST = 'api.athlya.app';

export interface DemoModeEnv {
  readonly NEXT_PUBLIC_DEMO_MODE?: string | undefined;
  readonly APP_ENV?: string | undefined;
  readonly NEXT_PUBLIC_API_URL?: string | undefined;
}

function isProductionApiUrl(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  try {
    return new URL(raw).hostname.toLowerCase() === PRODUCTION_API_HOST;
  } catch {
    return false;
  }
}

/**
 * `true` when the build is a demo build. Only the exact value `1` turns
 * it on. Throws when the flag is on for a production build.
 */
export function resolveDemoMode(env: DemoModeEnv): boolean {
  if (env.NEXT_PUBLIC_DEMO_MODE !== '1') return false;
  if (env.APP_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_DEMO_MODE=1 is refused when APP_ENV=production: the demo mode never ships to production.',
    );
  }
  if (isProductionApiUrl(env.NEXT_PUBLIC_API_URL)) {
    throw new Error(
      `NEXT_PUBLIC_DEMO_MODE=1 is refused with the production API (${PRODUCTION_API_HOST}): the demo mode never ships to production.`,
    );
  }
  return true;
}
