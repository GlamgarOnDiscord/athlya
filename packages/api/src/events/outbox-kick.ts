/**
 * Event-driven outbox drain — "outbox kick" (issue #311).
 *
 * The cron drain runs once per minute, so an event that only reached the
 * outbox (direct publish failed, or a Worker without lane queue bindings)
 * could wait up to a minute plus a cycle. The RGPD lane must be delivered
 * within 30 s of creation.
 *
 * Producer side:
 *   • Every outbox writer calls {@link noteOutboxWrite} once its row is
 *     written. The call only flags the current request scope.
 *   • {@link runWithOutboxKickScope}, installed on `/v1/*` by
 *     `installDomainScope`, sends one `outbox.kick` message to
 *     `OUTBOX_KICK_QUEUE` after the handler has returned (the transaction
 *     is committed by then), through `ctx.waitUntil`.
 *   • {@link OutboxKickCoalescer} sends at most one kick per isolate per
 *     {@link OUTBOX_KICK_MIN_INTERVAL_MS}. A request inside the window
 *     arms a single trailing kick instead, so every committed row is still
 *     followed by a kick sent after its commit.
 *
 * Consumer side (gateway `queue()` handler):
 *   • {@link handleOutboxKickBatch} runs ONE bounded drain for the whole
 *     batch, however many kicks it holds. The consumer is configured with
 *     `max_concurrency = 1`, so a burst becomes a few sequential drains
 *     rather than one per request.
 *   • The drain claims through `claimLeasedBatch`: rows leased by the cron
 *     drain (or another kick drain) are skipped, so the two paths never
 *     send the same row concurrently.
 *
 * Failures never fail the request: a kick that cannot be sent is logged
 * and the cron drain remains the safety net.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { COMPLIANCE_EVENT_TYPES } from './route-queue.js';

/** Body `type` of a kick message. */
export const OUTBOX_KICK_MESSAGE_TYPE = 'outbox.kick';

/** At most one kick per isolate per window; the rest coalesce into a trailing kick. */
export const OUTBOX_KICK_MIN_INTERVAL_MS = 1_000;

/** Delay before a failed kick batch is retried by the queue. */
export const OUTBOX_KICK_RETRY_DELAY_SECONDS = 5;

/** Message produced on `OUTBOX_KICK_QUEUE`. Carries no event data. */
export interface OutboxKickMessage {
  readonly type: typeof OUTBOX_KICK_MESSAGE_TYPE;
  readonly sentAt: string;
  /** True when a compliance event (`COMPLIANCE_EVENT_TYPES`) triggered it. */
  readonly compliance: boolean;
}

/** Minimal producer surface of the Cloudflare Queues binding. */
export interface OutboxKickProducer {
  send(message: unknown): Promise<unknown>;
}

/** Subset of `ExecutionContext` used to outlive the response. */
export interface KickExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const COMPLIANCE_TYPES = new Set(COMPLIANCE_EVENT_TYPES);

interface KickScope {
  written: boolean;
  compliance: boolean;
}

const kickScope = new AsyncLocalStorage<KickScope>();

/**
 * Flag the current request as having written an outbox row. A no-op
 * outside a request scope (cron, queue consumers, scripts).
 */
export function noteOutboxWrite(eventType?: string): void {
  const scope = kickScope.getStore();
  if (scope === undefined) return;
  scope.written = true;
  if (eventType !== undefined && COMPLIANCE_TYPES.has(eventType)) {
    scope.compliance = true;
  }
}

async function sendKick(producer: OutboxKickProducer, compliance: boolean): Promise<void> {
  const message: OutboxKickMessage = {
    type: OUTBOX_KICK_MESSAGE_TYPE,
    sentAt: new Date().toISOString(),
    compliance,
  };
  try {
    await producer.send(message);
  } catch (err) {
    console.warn('outbox.kick_failed', {
      metric: 'outbox_kick_failed',
      compliance,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface OutboxKickCoalescerOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Per-isolate throttle with a trailing edge.
 *
 *   • Outside the window: send now.
 *   • Inside the window, no trailing kick armed: arm one for the end of
 *     the window and return its promise (the caller keeps it alive with
 *     `waitUntil`).
 *   • Inside the window, trailing kick already armed: nothing to do — that
 *     kick is sent after this request's commit, so it covers its rows. The
 *     returned promise is already resolved: a request never awaits a
 *     promise owned by another request.
 */
export class OutboxKickCoalescer {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private trailingArmed = false;
  private trailingCompliance = false;

  public constructor(options: OutboxKickCoalescerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? OUTBOX_KICK_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  public kick(producer: OutboxKickProducer, compliance: boolean): Promise<void> {
    if (this.trailingArmed) {
      this.trailingCompliance ||= compliance;
      return Promise.resolve();
    }
    const waitMs = this.lastSentAt + this.minIntervalMs - this.now();
    if (waitMs <= 0) {
      this.lastSentAt = this.now();
      return sendKick(producer, compliance);
    }
    this.trailingArmed = true;
    this.trailingCompliance = compliance;
    return this.sleep(waitMs).then(() => {
      const trailingCompliance = this.trailingCompliance;
      this.trailingArmed = false;
      this.trailingCompliance = false;
      this.lastSentAt = this.now();
      return sendKick(producer, trailingCompliance);
    });
  }
}

const isolateCoalescer = new OutboxKickCoalescer();

/** Request surface needed by {@link runWithOutboxKickScope} (a Hono context fits). */
export interface KickRequestContext {
  readonly env: { readonly OUTBOX_KICK_QUEUE?: OutboxKickProducer | undefined };
  readonly executionCtx: KickExecutionContext;
}

function executionCtxOf(c: KickRequestContext): KickExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    // Hono throws when the request has no ExecutionContext (unit tests).
    return undefined;
  }
}

/**
 * Run `next` in a fresh kick scope, then — once the handler returned, so
 * after its transaction committed — kick the drain if an outbox row was
 * written. The kick runs regardless of the response status: a 5xx can
 * follow a commit, and a kick with nothing to drain costs one empty claim.
 */
export async function runWithOutboxKickScope(
  c: KickRequestContext,
  next: () => Promise<void>,
  coalescer: OutboxKickCoalescer = isolateCoalescer,
): Promise<void> {
  const scope: KickScope = { written: false, compliance: false };
  try {
    await kickScope.run(scope, next);
  } finally {
    const producer = scope.written ? c.env.OUTBOX_KICK_QUEUE : undefined;
    if (producer !== undefined) {
      const kick = coalescer.kick(producer, scope.compliance);
      const ctx = executionCtxOf(c);
      if (ctx !== undefined) {
        ctx.waitUntil(kick);
      } else {
        await kick;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Consumer                                                           */
/* ------------------------------------------------------------------ */

/** True for the kick queue of any environment (`athlya-outbox-kick*`). */
export function isOutboxKickQueue(queueName: string): boolean {
  return queueName.includes('outbox-kick') && !queueName.endsWith('-dlq');
}

/** Subset of a Cloudflare `MessageBatch` used by the kick consumer. */
export interface OutboxKickBatch {
  readonly queue: string;
  readonly messages: ReadonlyArray<{ readonly body: unknown }>;
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

/** Outcome of one kick drain, or `null` when the drain was skipped. */
export interface KickDrainOutcome {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly released: number;
}

/**
 * Coalesce a whole batch of kicks into ONE bounded drain. A drain that
 * throws (database unreachable) retries the batch after a short delay;
 * the queue's `max_retries` bounds that, and the cron stays the backstop.
 */
export async function handleOutboxKickBatch(
  batch: OutboxKickBatch,
  runDrain: () => Promise<KickDrainOutcome | null>,
): Promise<void> {
  const kicks = batch.messages.length;
  const compliance = batch.messages.some(
    (m) =>
      typeof m.body === 'object' &&
      m.body !== null &&
      (m.body as Partial<OutboxKickMessage>).compliance === true,
  );
  try {
    const result = await runDrain();
    console.log('outbox.kick_drain', {
      metric: 'outbox_kick_drain',
      kicks,
      compliance,
      skipped: result === null,
      ...(result ?? {}),
    });
    batch.ackAll();
  } catch (err) {
    console.error('outbox.kick_drain_failed', {
      metric: 'outbox_kick_drain_failed',
      queue: batch.queue,
      kicks,
      error: err instanceof Error ? err.message : String(err),
    });
    batch.retryAll({ delaySeconds: OUTBOX_KICK_RETRY_DELAY_SECONDS });
  }
}
