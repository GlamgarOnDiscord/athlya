/**
 * Barrel export for `@athlya/auth`.
 *
 * Subpath imports (`@athlya/auth/password`, `@athlya/auth/hibp`,
 * `@athlya/auth/jwt`) are preferred in downstream packages because
 * they let bundlers skip unused modules entirely. This barrel exists
 * so one-off scripts, tests and documentation examples can pull
 * everything from a single import without paying a noticeable bundle
 * cost.
 *
 * Because both `./password` and `./jwt` export a function called
 * `verify` (for passwords and JWTs respectively), the barrel resolves
 * the collision by **renaming** the password helpers:
 *
 *   - `hash`   → `hashPassword`
 *   - `verify` → `verifyPassword`
 *
 * Callers that need the unqualified names should import from the
 * subpath: `import { hash, verify } from '@athlya/auth/password'`.
 *
 * Later tasks in Epic 3 will extend this barrel with the Auth service
 * use cases (3.3) and the login-attempt throttle (3.5).
 *
 * The `verify` name is taken by JWT verification (which is re-exported
 * unchanged from `./jwt`). Password and QR helpers whose default names
 * also collide with `verify` are re-exported here under qualified
 * aliases:
 *
 *   - Password: `hash` → `hashPassword`, `verify` → `verifyPassword`.
 *
 * QR helpers keep their own distinct names (`generateAccessQR`,
 * `verifyAccessQR`) so they need no aliasing.
 */

export {
  BCRYPT_COST,
  EmptyPasswordError,
  hash as hashPassword,
  verify as verifyPassword,
} from './password.js';
export * from './hibp.js';
export * from './jwt.js';
export * from './login-anomaly.js';
export * from './qr.js';
export * from './replay-redis.js';
export * from './throttle.js';
export * from './service.js';
export * from './forgot-password.js';
export * from './sessions.js';
