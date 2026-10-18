/**
 * Barrel export for `@athlya/ai-coach` (Epic 21).
 *
 *   - `./service.js` — `askCoach` / `getCoachQuota` use cases and ports.
 *   - `./context.js` — minimised training context builder.
 *   - `./prompt.js`  — system and user prompts.
 *   - `./errors.js`  — `CoachError` (SDK-free, for the HTTP layer).
 */

export * from './service.js';
export * from './context.js';
export * from './prompt.js';
export * from './errors.js';
