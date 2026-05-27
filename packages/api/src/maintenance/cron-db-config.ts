/**
 * CRON_DB_URL configuration helpers — issue #64 (RGPD maintenance).
 *
 * Staging/production must provision a dedicated Postgres role
 * (`athlya_cron`) via `CRON_DB_URL`. Dev may omit the binding.
 */

export function shouldRequireCronDbUrl(environment: string | undefined): boolean {
  return environment === 'staging' || environment === 'production';
}

export function isCronDbUrlConfigured(url: string | undefined): boolean {
  return typeof url === 'string' && url.trim() !== '';
}

let cronDbUrlWarned = false;

/** Test seam — reset the once-per-isolate warning flag. */
export function resetCronDbUrlWarnedForTests(): void {
  cronDbUrlWarned = false;
}

/**
 * Emit a structured error when RGPD maintenance is skipped because
 * `CRON_DB_URL` is absent in a non-dev environment.
 */
export function logCronDbUrlMissing(opts: {
  readonly environment: string;
  readonly cron?: string;
  readonly scheduledTime?: number;
  readonly warnOnce?: boolean;
}): void {
  if (opts.warnOnce !== false && cronDbUrlWarned) {
    return;
  }
  if (opts.warnOnce !== false) {
    cronDbUrlWarned = true;
  }
  console.error('[worker] CRON_DB_URL missing — RGPD maintenance skipped', {
    code: 'configuration_error',
    binding: 'CRON_DB_URL',
    environment: opts.environment,
    event: 'rgpd_maintenance_cycle_skipped',
    cron: opts.cron,
    scheduledTime: opts.scheduledTime,
  });
}
