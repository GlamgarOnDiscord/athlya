import type { AthlyaBindings } from '../types.js';

/**
 * Postgres wire URL for interactive write transactions (book/cancel).
 * Prefers Hyperdrive when the binding is provisioned; falls back to
 * direct Neon `DB_URL` in dev and preview.
 */
export function resolvePostgresWriteUrl(env: AthlyaBindings): string {
  return env.HYPERDRIVE?.connectionString ?? env.DB_URL;
}

/** True when the write path routes through a Hyperdrive binding. */
export function usesHyperdriveWritePath(env: AthlyaBindings): boolean {
  return env.HYPERDRIVE !== undefined;
}
