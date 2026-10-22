/**
 * Pure parts of `seed-test-accounts.mjs` (issue #758): the fictional
 * studio, one account per role, and the checks run before any
 * connection is opened. Kept free of I/O so the unit test covers them.
 */

/** The fictional studio every test account belongs to. */
export const TEST_STUDIO = Object.freeze({
  slug: 'studio-rive-gauche',
  name: 'Studio Rive Gauche',
});

/**
 * One account per role. `.test` is reserved by RFC 2606: no mail for
 * these addresses can ever reach a real inbox.
 */
export const TEST_ACCOUNTS = Object.freeze([
  { role: 'admin', displayName: 'Camille Durand', email: 'camille.durand@rive-gauche.athlya.test' },
  { role: 'manager', displayName: 'Hugo Lefebvre', email: 'hugo.lefebvre@rive-gauche.athlya.test' },
  { role: 'accueil', displayName: 'Sarah Benali', email: 'sarah.benali@rive-gauche.athlya.test' },
  { role: 'coach', displayName: 'Inès Garnier', email: 'ines.garnier@rive-gauche.athlya.test' },
  { role: 'member', displayName: 'Léa Fontaine', email: 'lea.fontaine@rive-gauche.athlya.test' },
]);

/**
 * CGU version the accounts consent under. Mirrors `CURRENT_CGU_VERSION` of
 * `@athlya/auth`, which `@athlya/db` does not depend on; a unit test keeps
 * the two equal.
 */
export const CONSENTS_VERSION = '2026-01';

/** `APP_ENV` values that may be seeded without `--allow-production`. */
const NON_PRODUCTION_ENVIRONMENTS = new Set(['development', 'staging']);

/** Shortest password the register route accepts. */
const MIN_PASSWORD_LENGTH = 12;
/** bcrypt reads at most 72 bytes of its input. */
const MAX_PASSWORD_BYTES = 72;

/**
 * @param {readonly string[]} argv  `process.argv.slice(2)`
 * @returns {{ allowProduction: boolean }}
 */
export function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--allow-production');
  if (unknown.length > 0) {
    throw new Error(`unknown argument: ${unknown.join(' ')} (only --allow-production is accepted)`);
  }
  return { allowProduction: argv.includes('--allow-production') };
}

/**
 * Read and check the environment. Throws with a message that never
 * contains the password or the connection string.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ allowProduction: boolean }} flags
 * @returns {{ databaseUrl: string, password: string }}
 */
export function readSeedEnvironment(env, flags) {
  // An unset or unknown APP_ENV counts as production: a tunnel to the
  // production database looks local to the host guard.
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (!NON_PRODUCTION_ENVIRONMENTS.has(appEnv) && !flags.allowProduction) {
    throw new Error(
      `APP_ENV=${appEnv === '' ? '(unset)' : appEnv}: refusing to seed test accounts without --allow-production (set APP_ENV=development or staging)`,
    );
  }
  const databaseUrl = env.DATABASE_URL ?? '';
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const password = env.TEST_ACCOUNTS_PASSWORD ?? '';
  if (password === '') throw new Error('TEST_ACCOUNTS_PASSWORD is required');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`TEST_ACCOUNTS_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    throw new Error(`TEST_ACCOUNTS_PASSWORD must be at most ${MAX_PASSWORD_BYTES} bytes (bcrypt)`);
  }
  return { databaseUrl, password };
}

/**
 * The consents record of a seeded account: every optional purpose off.
 *
 * @param {Date} now
 */
export function seedConsents(now) {
  return {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: CONSENTS_VERSION,
    updatedAt: now.toISOString(),
  };
}
