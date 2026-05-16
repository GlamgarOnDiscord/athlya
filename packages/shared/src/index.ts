/**
 * Barrel export for `@athlya/shared`.
 *
 * Subpath imports (`@athlya/shared/tokens`, `@athlya/shared/i18n`,
 * `@athlya/shared/ids`) are preferred in downstream packages because they
 * let bundlers skip unused modules entirely. This barrel exists so one-off
 * scripts, tests and documentation examples can pull everything from a
 * single import without paying a noticeable bundle cost.
 */
export * from './tokens.js';
export * from './i18n/index.js';
export * from './ids.js';
export * from './schemas/index.js';
export * from './codec/index.js';
export * from './events.js';
export * from './theming/index.js';
