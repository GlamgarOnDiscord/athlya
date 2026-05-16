/**
 * RGPD maintenance scheduled runner — Sprint 8 / SP7.6
 * (Vague 36) — finalises code-side wiring for S5-003.
 *
 * Bridges the framework-free maintenance primitives shipped in
 * Sprint 2 (`rgpd-purge.ts`) and Sprint 6 (`audit-anonymize.ts`)
 * onto the Cloudflare Worker `scheduled()` entrypoint. Today
 * the cron-driven invocation in `worker.ts` only runs the outbox
 * drain; this module supplies an additional aggregate that the
 * scheduled handler can fire on a slower cadence (every Nth tick)
 * to keep the RGPD compliance windows closing on schedule:
 *
 *   • `runRgpdMaintenanceCycle` — anonymise users J+30, purge
 *     outbox 7d, purge export_jobs 90d (Sprint 2 SP2.2 + SP2.3).
 *   • `runAuditAnonymisationCycle` — fan-out anonymisation for
 *     every user whose 30-day grace window elapsed (Sprint 6 SP6.2,
 *     audit S5-003).
 *
 * The runner accepts a `SqlExecutor`-shaped surface, mirroring the
 * primitives. Production wiring inverts control: `worker.ts`
 * supplies an executor backed by `db.execute(sql)` from the
 * existing Drizzle handle returned by `env.getDb()`. Tests inject
 * an in-memory recorder.
 *
 * Failure handling: per-job failures are isolated. The runner
 * logs each error through the supplied logger (or `console.error`)
 * but never throws — the caller (the `scheduled()` handler)
 * mustn't surface a maintenance failure as an unhandled rejection
 * because it would mask the success of any other concurrent job.
 *
 * @see packages/api/src/maintenance/rgpd-purge.ts
 * @see packages/api/src/maintenance/audit-anonymize.ts
 */

import {
    type AnonymizeOneFn,
    runAuditAnonymisationCycle,
} from './audit-anonymize.js';
import {
    type SqlExecutor,
    runRgpdMaintenanceCycle,
} from './rgpd-purge.js';

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

interface MaintenanceLogger {
    info(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
}

const consoleLogger: MaintenanceLogger = {
    info: (msg, ctx) => {
        console.log(msg, ctx);
    },
    error: (msg, ctx) => {
        console.error(msg, ctx);
    },
};

export interface ScheduledRgpdDeps {
    /**
     * SQL executor implementing the same contract used by the
     * underlying primitives. `execute` is consumed by
     * `runRgpdMaintenanceCycle`; `selectRows` is consumed by
     * `runAuditAnonymisationCycle`. A single Drizzle adapter
     * implements both surfaces — see `worker.ts` wiring.
     */
    readonly executeSql: SqlExecutor & {
        selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
    };
    /**
     * Per-user audit anonymisation function — typically wraps
     * `anonymizeAuditLog` from `@athlya/members` with a
     * `DeletionRepo.anonymizeAuditRows` adapter. Optional — when
     * absent, the audit anonymisation pass is skipped (no-op).
     */
    readonly anonymizeOne?: AnonymizeOneFn;
    readonly logger?: MaintenanceLogger;
}

export interface ScheduledRgpdResult {
    readonly purge: {
        readonly anonymizedUsers: number;
        readonly purgedOutbox: number;
        readonly purgedExportJobs: number;
        readonly error?: string;
    };
    readonly auditAnonymise:
    | {
        readonly skipped: true;
        readonly reason: string;
    }
    | {
        readonly skipped: false;
        readonly processed: number;
        readonly succeeded: number;
        readonly anonymizedRowsTotal: number;
        readonly errorCount: number;
    };
}

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Run one maintenance tick. Aggregates all RGPD-side cron work
 * the platform owes per the audit-driven retention policy.
 *
 * Invocation cadence is the caller's choice. Daily fires are
 * sufficient for the volumes the audit scoped — the data-purge
 * windows (7 days outbox, 30 days users, 90 days export_jobs)
 * absorb a missed tick comfortably. The Worker `scheduled()`
 * handler delegates to this function via `ctx.waitUntil`, so a
 * tick can run for several seconds without back-pressure on
 * cron-trigger budget.
 */
export async function runScheduledRgpdMaintenance(
    deps: ScheduledRgpdDeps,
): Promise<ScheduledRgpdResult> {
    const logger = deps.logger ?? consoleLogger;

    let purge: ScheduledRgpdResult['purge'] = {
        anonymizedUsers: 0,
        purgedOutbox: 0,
        purgedExportJobs: 0,
    };
    try {
        const r = await runRgpdMaintenanceCycle(deps.executeSql);
        purge = {
            anonymizedUsers: r.anonymizedUsers,
            purgedOutbox: r.purgedOutbox,
            purgedExportJobs: r.purgedExportJobs,
        };
        logger.info('rgpd maintenance: purge cycle complete', purge);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        purge = { ...purge, error: message };
        logger.error('rgpd maintenance: purge cycle failed', { error: message });
    }

    if (deps.anonymizeOne === undefined) {
        return {
            purge,
            auditAnonymise: {
                skipped: true,
                reason: 'anonymizeOne not wired — production needs the @athlya/members adapter',
            },
        };
    }

    try {
        const r = await runAuditAnonymisationCycle({
            executeSql: deps.executeSql,
            anonymizeOne: deps.anonymizeOne,
        });
        const summary = {
            processed: r.processed,
            succeeded: r.succeeded,
            anonymizedRowsTotal: r.anonymizedRowsTotal,
            errorCount: r.errors.length,
        };
        logger.info('rgpd maintenance: audit anonymise cycle complete', summary);
        return {
            purge,
            auditAnonymise: {
                skipped: false,
                ...summary,
            },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('rgpd maintenance: audit anonymise cycle failed', {
            error: message,
        });
        return {
            purge,
            auditAnonymise: {
                skipped: true,
                reason: `audit cycle threw: ${message}`,
            },
        };
    }
}
