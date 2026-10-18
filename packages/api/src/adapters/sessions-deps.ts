/**
 * Compose the router-level {@link SessionsDeps} bundle from a live
 * `AthlyaBindings` env — issue #652.
 *
 *   - `logSession` / `listSessions` run the `@athlya/members` use cases
 *     over {@link createDrizzleWorkoutSessionRepo}, on the postgres-js
 *     write handle (Hyperdrive when bound), every statement inside
 *     `withTenant` with the caller's claims.
 *   - The owner is always the JWT subject, and the studio is the JWT
 *     studio: a body `studioId` naming another studio is refused before
 *     any write (`studio_mismatch`).
 *   - Idempotency uses the shared Neon HTTP handle, scoped to the
 *     caller's claims (see `tenant-idempotency.ts`). The request key is
 *     also stored with the session, so racing retries that both miss
 *     that cache still write one row (migration 0044).
 */

import { listSessions, logSession, type SessionsServiceDeps } from '@athlya/members';

import { getOrCreateDbHttp, getOrCreateWriteDb } from './deps-cache.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';
import {
  WorkoutSessionStudioMismatchError,
  createDrizzleWorkoutSessionRepo,
} from './workout-sessions-repo-drizzle.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { SessionsDeps } from '../routes/sessions.js';
import type { AthlyaBindings } from '../types.js';
import type { TenantClaims } from '@athlya/db/client';

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

export function buildSessionsDeps(env: AthlyaBindings): SessionsDeps {
  const service = (claims: AuthClaims): SessionsServiceDeps => ({
    repo: createDrizzleWorkoutSessionRepo(getOrCreateWriteDb(env), toTenantClaims(claims)),
  });

  return {
    async logSession(claims, input, idempotencyKey) {
      if (input.studioId !== undefined && input.studioId !== claims.studioId) {
        return { kind: 'studio_mismatch' };
      }
      try {
        const session = await logSession(claims.userId, input, service(claims), {
          idempotencyKey,
        });
        return { kind: 'created', session };
      } catch (err) {
        if (err instanceof WorkoutSessionStudioMismatchError) {
          return { kind: 'studio_mismatch' };
        }
        throw err;
      }
    },
    listSessions(claims, range) {
      return listSessions(claims.userId, range, service(claims));
    },
    idempotencyFor(claims) {
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims)),
      };
    },
  };
}
