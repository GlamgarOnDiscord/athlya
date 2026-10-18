/**
 * Feature flags wrapper.
 *
 * Sprint 14 / Slice 14.4 (Epic CN.4.2). Adapter par défaut
 * statique pour pouvoir wirer des flags dans le code AVANT que
 * GrowthBook (ou un autre provider) soit provisionné.
 *
 * Usage :
 *
 *     import { isEnabled } from '@athlya/api/feature-flags';
 *     if (await isEnabled('ai-coach', { userId, studioId })) {
 *         // …
 *     }
 *
 * Le wrapper accepte un provider injecté par les deps (ex
 * `members-deps.ts`). Le provider par défaut lit
 * `env.FEATURE_FLAGS_JSON` qui contient un JSON statique
 * `{ flag: boolean | { rollout: 0..100 } }`.
 *
 * Catalogue des flags pilotes (Sprint 14, Epic CN.4.3) :
 *
 *   - `ai-coach` — gates Epic 21 (AI coach, `/v1/coach`), wired in
 *     `adapters/coach-deps.ts`.
 *     Default OFF, enable on staging d'abord.
 *   - `waitlist-auto-promotion-v2` — alternative algorithm to
 *     `cancelReservation` (FIFO + priority par badge). Default
 *     OFF.
 *   - `new-billing-flow` — new Stripe Checkout integration with
 *     PaymentIntent vs current Subscription Checkout. Default
 *     OFF.
 *
 * Cache : per-isolate, TTL 60s. Les flags ne changent pas plus
 * vite que ça en pratique, et un cache plus court ferait spammer
 * le provider sur le hot path.
 */

/** Context evaluated against rollout rules. */
export interface FeatureFlagContext {
  readonly userId?: string;
  readonly studioId?: string;
  readonly role?: string;
  /**
   * Hash bucket for rollout percentage. Computed from `userId`
   * by default; falls back to a uniform-random bucket per
   * isolate when no userId is available.
   */
  readonly bucket?: number;
}

/** Single flag definition. */
export type FlagDefinition =
  | boolean
  | {
      /** % of traffic to enable. 0–100. */
      readonly rollout: number;
      /**
       * Allow-list of user IDs that always see the flag ON,
       * regardless of `rollout`. Used to ship to internal
       * users first.
       */
      readonly allowList?: readonly string[];
      /**
       * Allow-list of studio IDs. Same semantic — flag ON
       * for any user in the listed studios.
       */
      readonly studioAllowList?: readonly string[];
    };

/** Provider interface — `getFlag(name, ctx)` returns the resolved value. */
export interface FeatureFlagProvider {
  getFlag(name: string, ctx: FeatureFlagContext): Promise<boolean>;
}

/** Cache entry for the per-isolate evaluator cache. */
interface CacheEntry {
  readonly value: boolean;
  readonly expiresAtMs: number;
}

/** Default cache TTL — 60 seconds per the slice doc. */
export const FLAG_CACHE_TTL_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Static JSON provider                                                */
/* ------------------------------------------------------------------ */

/**
 * Build a provider that reads flags from a static JSON catalogue.
 *
 * Format :
 *   - `boolean` — applies uniformly to all contexts
 *   - `{ rollout: 0..100, allowList?, studioAllowList? }` — bucketed
 *
 * Sample :
 *
 *     {
 *       "ai-coach": false,
 *       "waitlist-auto-promotion-v2": {
 *         "rollout": 10,
 *         "studioAllowList": ["studio-test-uuid"]
 *       }
 *     }
 */
export function buildStaticFeatureFlagProvider(
  catalogueJson: string | undefined,
): FeatureFlagProvider {
  let catalogue: Record<string, unknown> = {};
  if (typeof catalogueJson === 'string' && catalogueJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(catalogueJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        catalogue = parsed as Record<string, unknown>;
      } else {
        console.warn('feature-flags: FEATURE_FLAGS_JSON is not an object, defaulting to {}');
      }
    } catch {
      console.warn('feature-flags: FEATURE_FLAGS_JSON malformed, defaulting to {}');
    }
  }

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async getFlag(name, ctx) {
      const def = asFlagDefinition(
        Object.prototype.hasOwnProperty.call(catalogue, name) ? catalogue[name] : undefined,
      );
      // Unknown or malformed definitions fail closed (OFF).
      if (def === undefined) return false;
      if (typeof def === 'boolean') return def;

      // Allow-lists override the rollout percentage.
      if (
        def.allowList !== undefined &&
        ctx.userId !== undefined &&
        def.allowList.includes(ctx.userId)
      ) {
        return true;
      }
      if (
        def.studioAllowList !== undefined &&
        ctx.studioId !== undefined &&
        def.studioAllowList.includes(ctx.studioId)
      ) {
        return true;
      }

      // Rollout: deterministic bucket from userId (or
      // random fallback). Pure-function so the same user
      // always lands in the same bucket — critical for
      // rollout consistency.
      const bucket = ctx.bucket ?? hashToBucket(ctx.userId ?? `random-${Math.random()}`);
      return bucket < def.rollout;
    },
  };
}

/**
 * Narrow a catalogue entry to a {@link FlagDefinition}, or `undefined`
 * when its shape is invalid (wrong types, rollout outside 0–100).
 */
function asFlagDefinition(value: unknown): FlagDefinition | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const def = value as { rollout?: unknown; allowList?: unknown; studioAllowList?: unknown };
  if (typeof def.rollout !== 'number' || !(def.rollout >= 0 && def.rollout <= 100)) {
    return undefined;
  }
  const isStringList = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (def.allowList !== undefined && !isStringList(def.allowList)) return undefined;
  if (def.studioAllowList !== undefined && !isStringList(def.studioAllowList)) return undefined;
  return {
    rollout: def.rollout,
    ...(def.allowList === undefined ? {} : { allowList: def.allowList }),
    ...(def.studioAllowList === undefined ? {} : { studioAllowList: def.studioAllowList }),
  };
}

/* ------------------------------------------------------------------ */
/*  Cached evaluator                                                    */
/* ------------------------------------------------------------------ */

/** Per-isolate cache — keyed on `${flag}|${userId}|${studioId}`. */
const cache = new Map<string, CacheEntry>();

/**
 * Evaluate a feature flag with a 60s per-key cache. The cache
 * bounds provider load on hot paths (e.g. middleware that checks
 * the flag on every request).
 */
export async function isEnabled(
  name: string,
  ctx: FeatureFlagContext,
  provider: FeatureFlagProvider,
  nowMs: () => number = Date.now,
): Promise<boolean> {
  const key = `${name}|${ctx.userId ?? ''}|${ctx.studioId ?? ''}`;
  const cached = cache.get(key);
  const now = nowMs();
  if (cached !== undefined && cached.expiresAtMs > now) {
    return cached.value;
  }
  const value = await provider.getFlag(name, ctx);
  cache.set(key, {
    value,
    expiresAtMs: now + FLAG_CACHE_TTL_MS,
  });
  return value;
}

/** Test seam — flush the cache between tests. */
export function __resetFeatureFlagCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Map an arbitrary string (typically `userId`) to a 0–99 bucket.
 * Same hash, same bucket — guarantees rollout consistency across
 * sessions.
 *
 * Implementation: cheap djb2-like hash, modulo 100. Not
 * cryptographically secure (sufficient for rollout bucketing).
 */
function hashToBucket(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(h) % 100;
}
