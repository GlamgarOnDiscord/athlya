/**
 * Public re-exports for the `@athlya/shared/schemas` subpath.
 *
 * Downstream packages typically import the narrower subpaths
 * (`@athlya/shared/schemas/domain`, `.../schemas/api`,
 * `.../schemas/problem`) so bundlers can tree-shake the schemas they
 * don't use. This barrel exists for tests, scripts and documentation
 * examples that pull from a single entry point.
 */

export * from './primitives.js';
export * from './consents.js';
export * from './domain.js';
export * from './api.js';
export * from './problem.js';
