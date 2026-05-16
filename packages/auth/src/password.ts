/**
 * Password hashing and verification primitives for `@athlya/auth`.
 *
 * Athlya runs exclusively on Cloudflare Workers at the edge, which means
 * the native C++ `bcrypt` binding is not available: Workers have no
 * Node.js `nan`/N-API surface. We therefore depend on **`bcryptjs`**, a
 * pure-JS implementation that works identically on Node 20 (the runner
 * for unit and property tests) and on Workers.
 *
 * The algorithm is bcrypt with **cost factor 12** — satisfying the
 * "bcrypt at cost ≥ 12" clause of Requirement 1.1. The cost is exported
 * as a constant so it can be audited and, if OWASP guidance shifts
 * upward, bumped in one place.
 *
 * Every call is asynchronous so that the Workers event loop can yield
 * between rounds — synchronous variants (`bcryptjs.hashSync`,
 * `compareSync`) would block the request for the full ~200 ms bcrypt
 * takes at cost 12 and are forbidden here.
 *
 * Related requirements: 1.1.
 */

import bcrypt from 'bcryptjs';

/**
 * bcrypt cost factor used for every hash produced by this package.
 *
 * Requirement 1.1 mandates `cost ≥ 12`. We pin to exactly 12 because it
 * is the OWASP 2024 lower bound; raising it later is backward
 * compatible (older hashes keep verifying, only newly hashed passwords
 * use the new cost).
 */
export const BCRYPT_COST = 12;

/**
 * Thrown when {@link hash} or {@link verify} is called with an empty
 * password. Empty passwords are rejected because they are both a
 * product-level bug (the API Gateway Zod schema should have refused
 * them) and a silent mis-use pattern for the bcrypt API, which would
 * happily hash an empty string.
 */
export class EmptyPasswordError extends Error {
    public override readonly name = 'EmptyPasswordError';
    public constructor() {
        super('password must be a non-empty string');
    }
}

/**
 * Hashes `password` with bcrypt at {@link BCRYPT_COST}.
 *
 * ### Preconditions
 *
 * - `password` is a non-empty string. bcrypt itself silently truncates
 *   input at 72 bytes (UTF-8), which is a known bcrypt property; we do
 *   not enforce length here because the API layer caps inputs upstream
 *   and rejecting here would break admin-reset flows that legitimately
 *   hash randomly generated long tokens.
 *
 * ### Postconditions
 *
 * - Returns a `$2a$` or `$2b$` / `$2y$` bcrypt string exactly 60
 *   characters long whose cost segment equals {@link BCRYPT_COST}.
 * - `verify(password, result) === true`.
 *
 * @throws {@link EmptyPasswordError} when `password` is an empty string.
 */
export async function hash(password: string): Promise<string> {
    if (password.length === 0) {
        throw new EmptyPasswordError();
    }
    return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 *
 * Returns `true` iff the hash was produced from `password` (at any cost
 * factor — bcrypt hashes embed their own cost, so older low-cost
 * hashes still verify correctly during a gradual cost bump). Any
 * malformed hash string causes bcrypt to return `false` rather than
 * throw.
 *
 * @throws {@link EmptyPasswordError} when `password` is an empty string.
 */
export async function verify(
    password: string,
    storedHash: string,
): Promise<boolean> {
    if (password.length === 0) {
        throw new EmptyPasswordError();
    }
    return bcrypt.compare(password, storedHash);
}
