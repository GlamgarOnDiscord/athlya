/**
 * `@athlya/ratelimit` — neutral sliding-window rate limiter.
 *
 * Extracted from `@athlya/api` in hardening H5 to break the
 * `@athlya/api` ↔ `@athlya/auth` dependency cycle. The public API
 * (`rateLimitSlidingWindow`, `RateLimitDecision`, `RateLimiterDeps`)
 * is unchanged — only the import path has moved.
 *
 * Requirements: 15.1, 15.2, 15.3.
 */

export * from './sliding-window.js';
