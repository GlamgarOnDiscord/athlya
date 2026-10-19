/**
 * Axiom log pipeline: Tail Worker consumed by the API Workers
 * (`tail_consumers` in each wrangler config, issue #697).
 *
 * Every `TraceItem` the producers emit reaches `tail()`. Each log entry
 * whose message is one console argument holding a plain object (what
 * `logEvent()` in `../logging.ts` emits) becomes one Axiom event: the
 * object's keys stay at the top level, which is the field contract the
 * Axiom monitors read (docs/runbooks/axiom-alerts-provision.md). The
 * event also carries `_time` and `level` of the log entry and, from the
 * trace, `scriptName`, `outcome`, `eventTimestamp` and the invocation
 * type (`eventType`, plus `cron` or `queue`). A key the log object sets
 * itself wins over that metadata. Everything else in the trace (request
 * URL and headers, exceptions, other log lines) is dropped.
 *
 * Events are posted in batches to the Axiom ingest API, dataset
 * `AXIOM_LOGS_DATASET` (var), token `AXIOM_INGEST_TOKEN` (secret). The
 * handler never throws and bounds each request: a failing or slow Axiom
 * loses that batch, never the producer's invocation.
 */

/** Bindings of `wrangler.axiom-tail.toml`. */
export interface AxiomTailEnv {
  readonly AXIOM_INGEST_TOKEN?: string;
  readonly AXIOM_LOGS_DATASET?: string;
  /** Axiom API origin; defaults to {@link DEFAULT_AXIOM_URL}. */
  readonly AXIOM_URL?: string;
}

/** One flat event as ingested by Axiom. */
export type AxiomEvent = Record<string, unknown>;

export const DEFAULT_AXIOM_URL = 'https://api.axiom.co';

/** Events per ingest request. */
export const INGEST_BATCH_SIZE = 500;

/** Per-request bound; a tail invocation has a limited wall time. */
export const INGEST_TIMEOUT_MS = 5_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Invocation type and its cron / queue name; nothing from fetch requests. */
function invocationFields(event: TraceItem['event']): AxiomEvent {
  if (event === null) return {};
  if ('cron' in event) return { eventType: 'scheduled', cron: event.cron };
  if ('queue' in event) return { eventType: 'queue', queue: event.queue };
  if ('request' in event) return { eventType: 'fetch' };
  return {};
}

/** The Axiom events of one tail batch, in log order. */
export function toAxiomEvents(items: readonly TraceItem[]): AxiomEvent[] {
  const events: AxiomEvent[] = [];
  for (const item of items) {
    const trace: AxiomEvent = {
      scriptName: item.scriptName,
      outcome: item.outcome,
      eventTimestamp: item.eventTimestamp,
      ...invocationFields(item.event),
    };
    for (const log of item.logs) {
      const args: unknown = log.message;
      if (!Array.isArray(args) || args.length !== 1) continue;
      const [fields] = args as unknown[];
      if (!isPlainObject(fields)) continue;
      events.push({
        _time: new Date(log.timestamp).toISOString(),
        level: log.level,
        ...trace,
        ...fields,
      });
    }
  }
  return events;
}

async function postBatch(
  url: string,
  token: string,
  batch: readonly AxiomEvent[],
  fetcher: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, INGEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(
        `[axiom-tail] ingest refused ${String(batch.length)} events: HTTP ${String(response.status)}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'unknown error';
    console.error(`[axiom-tail] ingest failed for ${String(batch.length)} events: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Ships the events of `items` to Axiom. Never rejects. */
export async function shipToAxiom(
  items: readonly TraceItem[],
  env: AxiomTailEnv,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    const events = toAxiomEvents(items);
    if (events.length === 0) return;
    const token = env.AXIOM_INGEST_TOKEN;
    const dataset = env.AXIOM_LOGS_DATASET;
    if (token === undefined || token === '' || dataset === undefined || dataset === '') {
      console.error('[axiom-tail] AXIOM_INGEST_TOKEN or AXIOM_LOGS_DATASET is not set');
      return;
    }
    const origin = (env.AXIOM_URL ?? DEFAULT_AXIOM_URL).replace(/\/+$/u, '');
    const url = `${origin}/v1/datasets/${encodeURIComponent(dataset)}/ingest`;
    const batches: AxiomEvent[][] = [];
    for (let start = 0; start < events.length; start += INGEST_BATCH_SIZE) {
      batches.push(events.slice(start, start + INGEST_BATCH_SIZE));
    }
    await Promise.all(batches.map((batch) => postBatch(url, token, batch, fetcher)));
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'unknown error';
    console.error(`[axiom-tail] dropped a tail batch: ${reason}`);
  }
}

export default {
  async tail(items, env) {
    await shipToAxiom(items, env);
  },
} satisfies ExportedHandler<AxiomTailEnv>;
