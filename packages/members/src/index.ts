/**
 * Barrel export for `@athlya/members`.
 *
 * Subpath imports (`@athlya/members/service`, `@athlya/members/sessions`)
 * are preferred in downstream packages because they let bundlers skip
 * unused modules entirely. This barrel exists so tests, scripts and
 * documentation examples can pull everything from a single import.
 *
 * Task 5.1 contributes the profile use cases via `./service.js`; task
 * 5.2 contributes the versioned consents update via `./consents.js`;
 * task 5.3 contributes the RGPD export flow via `./export.js`; task
 * 5.4 contributes the RGPD deletion cascade consumer and the
 * 30-day audit anonymisation job via `./cascade.js`; task 5.5
 * contributes the workout session use cases via `./sessions.js`; task
 * 22.1 contributes the progression aggregator via `./progression.js`;
 * issue #683 adds the cardio series via `./cardio-progression.js`.
 */

export * from './service.js';
export * from './consents.js';
export * from './sessions.js';
export * from './progression.js';
export * from './cardio-progression.js';
export * from './export.js';
export * from './cascade.js';
