/**
 * CSP violation report sink (issue #136).
 *
 * The member web app (`apps/web`) and studio app emit a strict
 * Content-Security-Policy with a `report-to` / `report-uri` directive
 * (see `apps/web/src/lib/csp.ts`). Without a sink, blocked-script and
 * other violations — the early-warning signal for an XSS injection
 * attempt — are invisible to ops.
 *
 * This public, unauthenticated `POST /v1/csp-report` accepts the two
 * payload shapes browsers send and emits one structured
 * `csp.violation` log line per report (metric `csp_violation_total`,
 * alert A18). It NEVER returns an error to the browser: a violation
 * report is fire-and-forget telemetry, so we always answer `204` (even
 * on a malformed body) and swallow parse failures into a counted
 * `csp.report_parse_error` metric.
 *
 * Payload shapes:
 *   • `application/csp-report` (legacy `report-uri`):
 *       `{ "csp-report": { "violated-directive": …, "blocked-uri": … } }`
 *   • `application/reports+json` (Reporting API `report-to`):
 *       `[ { "type": "csp-violation", "body": { "effectiveDirective": …,
 *            "blockedURL": … }, "url": …, "user_agent": … } ]`
 *
 * Abuse note: the endpoint is public, so it runs behind the gateway's
 * global fail-closed-soft IP limiter (issue #128) — a flood degrades to
 * 429 rather than unbounded log ingest. We additionally cap the number
 * of reports processed per request.
 */

import type { AthlyaBindings, AthlyaVariables } from '../types.js';
import type { Context } from 'hono';

export interface CspReportEnv {
  Bindings: AthlyaBindings;
  Variables: AthlyaVariables;
}

/** Structured-log message + metric name for a parsed violation (alert A18). */
export const CSP_VIOLATION_METRIC = 'csp_violation_total';
export const CSP_VIOLATION_LOG_MESSAGE = 'csp.violation';

/** Max reports processed per request — a single Reporting API POST may batch several. */
export const MAX_CSP_REPORTS_PER_REQUEST = 20;

interface NormalisedViolation {
  readonly effectiveDirective: string | null;
  readonly blockedUri: string | null;
  readonly documentUri: string | null;
  readonly disposition: string | null;
  readonly sourceFile: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalise either payload variant into a flat violation shape.
 * Returns `null` when the entry carries no recognisable CSP fields.
 */
function normalise(entry: Record<string, unknown>): NormalisedViolation | null {
  // Legacy report-uri: { "csp-report": {...} }
  const legacy = entry['csp-report'];
  const body =
    legacy !== undefined && legacy !== null && typeof legacy === 'object'
      ? (legacy as Record<string, unknown>)
      : // Reporting API: { type, body: {...} } — fall back to the entry itself
        ((entry['body'] as Record<string, unknown> | undefined) ?? entry);

  const effectiveDirective =
    str(body['effectiveDirective']) ?? str(body['violated-directive']);
  const blockedUri = str(body['blockedURL']) ?? str(body['blocked-uri']);
  const documentUri =
    str(body['documentURL']) ?? str(body['document-uri']) ?? str(entry['url']);
  const disposition = str(body['disposition']);
  const sourceFile = str(body['sourceFile']) ?? str(body['source-file']);

  if (
    effectiveDirective === null &&
    blockedUri === null &&
    documentUri === null
  ) {
    return null;
  }
  return { effectiveDirective, blockedUri, documentUri, disposition, sourceFile };
}

/** Coerce an arbitrary parsed JSON body into the list of report entries. */
function toEntries(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (e): e is Record<string, unknown> => e !== null && typeof e === 'object',
    );
  }
  if (parsed !== null && typeof parsed === 'object') {
    return [parsed as Record<string, unknown>];
  }
  return [];
}

/**
 * Handle a CSP violation report. Always resolves to `204`.
 */
export async function handleCspReport(c: Context<CspReportEnv>): Promise<Response> {
  const traceId = c.get('traceId');

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    console.warn('csp.report_parse_error', {
      metric: 'csp_report_parse_error_total',
      traceId,
      contentType: c.req.header('content-type') ?? null,
    });
    return c.body(null, 204);
  }

  const entries = toEntries(parsed).slice(0, MAX_CSP_REPORTS_PER_REQUEST);
  const userAgent = c.req.header('user-agent') ?? null;

  for (const entry of entries) {
    const v = normalise(entry);
    if (v === null) {
      continue;
    }
    console.warn(CSP_VIOLATION_LOG_MESSAGE, {
      metric: CSP_VIOLATION_METRIC,
      effectiveDirective: v.effectiveDirective,
      blockedUri: v.blockedUri,
      documentUri: v.documentUri,
      disposition: v.disposition,
      sourceFile: v.sourceFile,
      environment: c.env.ENVIRONMENT,
      userAgent,
      traceId,
    });
  }

  return c.body(null, 204);
}
