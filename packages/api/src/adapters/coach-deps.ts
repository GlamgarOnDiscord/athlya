/**
 * Production wiring of the `/v1/coach/*` router (Epic 21).
 *
 *   - Feature flag: `ai-coach`, read from the static catalogue in
 *     `FEATURE_FLAGS_JSON` through `feature-flags.ts`. Absent or
 *     malformed catalogue → OFF.
 *   - Model: Mistral through `@ai-sdk/mistral`, keyed by
 *     `MISTRAL_API_KEY` (model id `AI_COACH_MODEL`, default
 *     {@link DEFAULT_COACH_MODEL}; endpoint `MISTRAL_BASE_URL`, default
 *     the provider's `https://api.mistral.ai/v1`). Without a key, `ask`
 *     throws `CoachError('not_configured')` → 503.
 *   - A flag that cannot be evaluated (malformed catalogue, provider
 *     error) is OFF.
 *   - Sessions: the progression repo (`withTenantHttp`, RLS
 *     `workout_sessions_read_own`) on the region-routed read handle.
 *   - Consent: `users.consents.thirdParty`, read on the primary so a
 *     consent granted a moment ago is seen at once.
 *   - Daily quota: Upstash Redis counter
 *     `coach:quota:<day>:<userId>` (INCR + EXPIRE in one pipeline),
 *     limit `AI_COACH_DAILY_LIMIT` (default 10). A Redis failure fails
 *     closed (`quota_unavailable` → 503).
 */

import { createMistral } from '@ai-sdk/mistral';
import {
  askCoach,
  CoachError,
  getCoachQuota,
  type CoachModel,
  type CoachQuotaStore,
} from '@athlya/ai-coach';

import {
  buildStaticFeatureFlagProvider,
  isEnabled,
  type FeatureFlagProvider,
} from '../feature-flags.js';

import {
  getOrCreateDbHttp,
  getOrCreateDbHttpForRegion,
  getOrCreateRedisForEnv,
} from './deps-cache.js';
import { createDrizzleConsentsRepoHttp } from './members-consents-repo-drizzle.js';
import { createDrizzleProgressionRepoHttp } from './progression-repo-drizzle.js';

import type { RequestCf } from '../domain-deps.js';
import type { AuthClaims } from '../middleware/auth.js';
import type { CoachDeps } from '../routes/coach.js';
import type { AthlyaBindings } from '../types.js';

/** Feature flag gating the AI coach. */
export const AI_COACH_FLAG = 'ai-coach';

/** Mistral model used when `AI_COACH_MODEL` is unset. */
export const DEFAULT_COACH_MODEL = 'mistral-small-latest';

/** Redis key prefix of the daily quota counters. */
export const COACH_QUOTA_KEY_PREFIX = 'coach:quota';

const flagProviders = new Map<string, FeatureFlagProvider>();
const models = new Map<string, CoachModel>();

function flagProvider(json: string | undefined): FeatureFlagProvider {
  const key = json ?? '';
  let provider = flagProviders.get(key);
  if (provider === undefined) {
    provider = buildStaticFeatureFlagProvider(json);
    flagProviders.set(key, provider);
  }
  return provider;
}

function coachModel(env: AthlyaBindings): CoachModel {
  const apiKey = env.MISTRAL_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new CoachError('not_configured', 'MISTRAL_API_KEY is not set');
  }
  const modelId =
    env.AI_COACH_MODEL !== undefined && env.AI_COACH_MODEL.length > 0
      ? env.AI_COACH_MODEL
      : DEFAULT_COACH_MODEL;
  const baseURL =
    env.MISTRAL_BASE_URL !== undefined && env.MISTRAL_BASE_URL.length > 0
      ? env.MISTRAL_BASE_URL
      : undefined;
  const cacheKey = `${apiKey}::${modelId}::${baseURL ?? ''}`;
  let model = models.get(cacheKey);
  if (model === undefined) {
    model = createMistral(baseURL === undefined ? { apiKey } : { apiKey, baseURL })(modelId);
    models.set(cacheKey, model);
  }
  return model;
}

/** Parse `AI_COACH_DAILY_LIMIT`; `undefined` lets the use case default apply. */
export function parseCoachDailyLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return value > 0 ? value : undefined;
}

/** Redis-backed {@link CoachQuotaStore}. */
export function createRedisCoachQuotaStore(env: AthlyaBindings): CoachQuotaStore {
  const prefix = env.REDIS_KEY_PREFIX ?? '';
  const keyOf = (userId: string, day: string): string =>
    `${prefix}${COACH_QUOTA_KEY_PREFIX}:${day}:${userId}`;
  return {
    async increment(userId, day, ttlSec) {
      const redis = getOrCreateRedisForEnv(env);
      const key = keyOf(userId, day);
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, ttlSec);
      const [count] = await pipeline.exec<[number, number]>();
      return count;
    },
    async peek(userId, day) {
      const redis = getOrCreateRedisForEnv(env);
      const value = await redis.get<number | string>(keyOf(userId, day));
      const count = typeof value === 'string' ? Number.parseInt(value, 10) : value;
      return typeof count === 'number' && Number.isFinite(count) ? count : 0;
    },
  };
}

async function hasThirdPartyConsent(
  env: AthlyaBindings,
  claims: AuthClaims,
  userId: string,
): Promise<boolean> {
  const repo = createDrizzleConsentsRepoHttp(getOrCreateDbHttp(env.DB_URL), claims);
  const consents: unknown = await repo.findConsents(userId);
  return (
    typeof consents === 'object' &&
    consents !== null &&
    (consents as { thirdParty?: unknown }).thirdParty === true
  );
}

/** Build the `CoachDeps` bundle consumed by `buildCoachRouter`. */
export function buildCoachDeps(env: AthlyaBindings, cf?: RequestCf): CoachDeps {
  const quota = createRedisCoachQuotaStore(env);
  const dailyLimit = parseCoachDailyLimit(env.AI_COACH_DAILY_LIMIT);
  const limitDeps = dailyLimit === undefined ? {} : { dailyLimit };

  return {
    async isEnabled(claims) {
      try {
        return await isEnabled(
          AI_COACH_FLAG,
          { userId: claims.userId, studioId: claims.studioId, role: claims.role },
          flagProvider(env.FEATURE_FLAGS_JSON),
        );
      } catch {
        // A flag that cannot be evaluated is OFF.
        return false;
      }
    },

    async getStatus(claims) {
      const [thirdPartyConsent, quotaView] = await Promise.all([
        hasThirdPartyConsent(env, claims, claims.userId),
        getCoachQuota(claims.userId, { quota, ...limitDeps }),
      ]);
      return { enabled: true, thirdPartyConsent, quota: quotaView };
    },

    async ask(claims, request) {
      const model = coachModel(env);
      const sessions = createDrizzleProgressionRepoHttp(
        getOrCreateDbHttpForRegion(env, cf?.continent),
        claims,
      );
      return askCoach(claims.userId, request, {
        model,
        sessions,
        consents: { hasThirdPartyConsent: (userId) => hasThirdPartyConsent(env, claims, userId) },
        quota,
        ...limitDeps,
      });
    },
  };
}
