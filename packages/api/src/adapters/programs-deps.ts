/**
 * Compose the router-level {@link ProgramsDeps} bundle from a live
 * `AthlyaBindings` env — Epic 24, issue #640.
 *
 *   - Program and subscription operations run the `@athlya/programs`
 *     use cases over {@link createDrizzleProgramRepo}, on the
 *     postgres-js write handle (Hyperdrive when bound) so multi-statement
 *     writes share one tenant-scoped transaction.
 *   - Idempotency uses the shared Neon HTTP handle, scoped to the
 *     caller's claims (see `tenant-idempotency.ts`).
 */

import {
  archiveProgram,
  createProgram,
  getProgram,
  getTodayWorkouts,
  listMySubscriptions,
  listPrograms,
  subscribeToProgram,
  unsubscribeFromProgram,
  updateProgram,
  type ProgramViewer,
  type ProgramsServiceDeps,
} from '@athlya/programs';

import { getOrCreateDbHttp, getOrCreateWriteDb } from './deps-cache.js';
import { createDrizzleProgramRepo } from './programs-repo-drizzle.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { ProgramsDeps } from '../routes/programs.js';
import type { AthlyaBindings } from '../types.js';
import type { TenantClaims } from '@athlya/db/client';

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

function toViewer(claims: AuthClaims): ProgramViewer {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

export function buildProgramsDeps(env: AthlyaBindings): ProgramsDeps {
  const service = (claims: AuthClaims): ProgramsServiceDeps => ({
    repo: createDrizzleProgramRepo(getOrCreateWriteDb(env), toTenantClaims(claims)),
  });

  return {
    async listPrograms(claims, query) {
      return { items: await listPrograms(toViewer(claims), query, service(claims)) };
    },
    getProgram(claims, programId) {
      return getProgram(programId, service(claims));
    },
    createProgram(claims, input) {
      return createProgram(toViewer(claims), input, service(claims));
    },
    updateProgram(claims, programId, input) {
      return updateProgram(toViewer(claims), programId, input, service(claims));
    },
    archiveProgram(claims, programId) {
      return archiveProgram(toViewer(claims), programId, service(claims));
    },
    subscribe(claims, programId, input) {
      return subscribeToProgram(toViewer(claims), programId, input, service(claims));
    },
    unsubscribe(claims, programId) {
      return unsubscribeFromProgram(toViewer(claims), programId, service(claims));
    },
    async listMySubscriptions(claims) {
      return { items: await listMySubscriptions(toViewer(claims), service(claims)) };
    },
    getToday(claims, date) {
      return getTodayWorkouts(toViewer(claims), date, service(claims));
    },
    idempotencyFor(claims) {
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims)),
      };
    },
  };
}
