/**
 * Theming subpackage — per-tenant theme helpers shared between the
 * web, studio and mobile clients.
 *
 * Currently exposes the brand-color helpers added for task 15.2.
 * Keeping them behind this barrel leaves room for future theme
 * pieces (radii, spacing overrides) without widening the top-level
 * export surface.
 */
export * from './brand-color.js';
