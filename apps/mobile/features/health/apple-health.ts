/**
 * Apple Health import — task 18.1 (Requirements 3.3, 12.1).
 *
 * - Connect: needs the `thirdParty` consent (read fresh from
 *   `GET /v1/members/me`) and shows the HealthKit read permission sheet.
 *   The link starts {@link INITIAL_LOOKBACK_DAYS} days back.
 * - Import now: re-checks the consent, then reads the workouts added since
 *   the stored HealthKit anchor, page by page, and logs each one through
 *   `submitWrite` (sent now, or queued offline) with a key derived from
 *   the workout UUID. The anchor only moves once a whole page went
 *   through, so an interrupted import resumes with that page; the derived
 *   key and the API's `(user, source, external_id)` index make the replay
 *   harmless. Any API error stops the run without moving the anchor, a
 *   422 included: requests are validated against the API schema before
 *   they are sent, so a 422 means an API that does not know `source` yet
 *   (the app reached an older Worker), and skipping would lose the
 *   workouts for good.
 * - Disconnect: forgets the link and its anchor. HealthKit permissions
 *   can only be revoked in the Health app, which the screen says.
 *
 * Workouts deleted in Apple Health are not deleted in Athlya.
 */
import { z } from 'zod';

import { createAbortError, toErrorModel, type ErrorModel } from '../errors';
import { SESSIONS_PATH } from '../workouts/workout-form';
import { submitWrite, toJsonPayload, type WriteDeps } from '../writes';

import {
  APPLE_HEALTH_PROVIDER,
  buildHealthSessionRequest,
  importIdempotencyKey,
  type Sha256Hex,
  type Translate,
} from './workout-mapping';

import type { ApiClient } from '../../infrastructure/api/client';
import type { AppleHealthLinkStore } from '../../infrastructure/health/link-store';
import type { HealthStore } from '../../infrastructure/health/ports';
import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export const IMPORT_HEALTH_WORKOUT_KIND = 'importHealthWorkout';
export const INITIAL_LOOKBACK_DAYS = 30;
export const PAGE_SIZE = 50;
/** Upper bound of pages per run, so one tap never loops for ever. */
export const MAX_PAGES = 20;

const DAY_MS = 86_400_000;

export type HealthLinks = Pick<
  AppleHealthLinkStore,
  'get' | 'connect' | 'saveAnchor' | 'disconnect'
>;

export interface AppleHealthDeps {
  readonly health: HealthStore;
  readonly links: HealthLinks;
  readonly api: Pick<ApiClient, 'get'>;
  readonly writes: WriteDeps;
  readonly sha256: Sha256Hex;
  readonly t: Translate;
  readonly locale: Locale;
  readonly now: () => number;
}

/** Only the flag the import needs; the rest of the profile is ignored. */
const ConsentsProbeSchema = z.object({ consents: z.object({ thirdParty: z.boolean() }) });

async function hasThirdPartyConsent(api: AppleHealthDeps['api']): Promise<boolean> {
  return ConsentsProbeSchema.parse(await api.get<unknown>('/v1/members/me')).consents.thirdParty;
}

export type ConnectResult =
  | { readonly kind: 'connected' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'consentRequired' }
  | { readonly kind: 'error'; readonly error: ErrorModel };

export async function connectAppleHealth(
  deps: AppleHealthDeps,
  userId: string,
): Promise<ConnectResult> {
  try {
    if (!(await deps.health.isAvailable())) return { kind: 'unavailable' };
    if (!(await hasThirdPartyConsent(deps.api))) return { kind: 'consentRequired' };
    await deps.health.requestReadAuthorization();
    deps.links.connect(userId, deps.now() - INITIAL_LOOKBACK_DAYS * DAY_MS);
    return { kind: 'connected' };
  } catch (error) {
    return { kind: 'error', error: toErrorModel(error) };
  }
}

export function disconnectAppleHealth(
  links: Pick<HealthLinks, 'disconnect'>,
  userId: string,
): void {
  links.disconnect(userId);
}

export interface ImportCounts {
  /** Logged on the server during this run. */
  readonly imported: number;
  /** Waiting in the offline queue. */
  readonly queued: number;
  /** Not a session: no duration or invalid data. */
  readonly skipped: number;
}

export type ImportResult =
  | ({ readonly kind: 'done' } & ImportCounts)
  | { readonly kind: 'notConnected' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'consentRequired' }
  | ({ readonly kind: 'error'; readonly error: ErrorModel } & ImportCounts);

/** Read through a call so the check is not narrowed away across an `await`. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function importAppleHealthWorkouts(
  deps: AppleHealthDeps,
  userId: string,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const link = deps.links.get(userId);
  if (link === null) return { kind: 'notConnected' };
  let imported = 0;
  let queued = 0;
  let skipped = 0;
  try {
    if (!(await deps.health.isAvailable())) return { kind: 'unavailable' };
    if (!(await hasThirdPartyConsent(deps.api))) return { kind: 'consentRequired' };

    let anchor = link.anchor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await deps.health.queryWorkouts({
        anchor,
        since: new Date(link.sinceMs),
        limit: PAGE_SIZE,
      });
      const workouts = [...result.workouts].sort(
        (a, b) => a.startDate.getTime() - b.startDate.getTime(),
      );
      for (const workout of workouts) {
        if (isAborted(signal)) throw createAbortError();
        const request = buildHealthSessionRequest(workout, deps.t, deps.locale);
        if (request?.source === undefined) {
          skipped += 1;
          continue;
        }
        const idempotencyKey = await importIdempotencyKey(
          deps.sha256,
          APPLE_HEALTH_PROVIDER,
          request.source.externalId,
        );
        const outcome = await submitWrite<unknown>(deps.writes, {
          kind: IMPORT_HEALTH_WORKOUT_KIND,
          method: 'POST',
          path: SESSIONS_PATH,
          payload: toJsonPayload(request),
          idempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        });
        if (outcome.kind === 'sent') imported += 1;
        else queued += 1;
      }
      // Disconnected meanwhile: the link store ignores the anchor then.
      deps.links.saveAnchor(userId, result.anchor);
      anchor = result.anchor;
      if (result.workouts.length < PAGE_SIZE) break;
    }
    return { kind: 'done', imported, queued, skipped };
  } catch (error) {
    if (isAborted(signal)) throw error;
    return { kind: 'error', error: toErrorModel(error), imported, queued, skipped };
  }
}

export interface HealthNotice {
  readonly key: TranslationKeys;
  readonly values?: Record<string, number>;
  readonly tone: 'info' | 'error';
}

/** What the screen announces after connect or import; errors carry their own message. */
export function healthNotice(result: ConnectResult | ImportResult): HealthNotice | null {
  switch (result.kind) {
    case 'connected':
    case 'error':
      return null;
    case 'unavailable':
      return { key: 'mobile.health.unavailable', tone: 'error' };
    case 'consentRequired':
      return { key: 'mobile.health.consentRequired', tone: 'error' };
    case 'notConnected':
      return { key: 'mobile.health.disconnected', tone: 'info' };
    case 'done': {
      const { imported, queued, skipped } = result;
      if (imported + queued + skipped === 0)
        return { key: 'mobile.health.result.none', tone: 'info' };
      return {
        key: 'mobile.health.result.done',
        values: { imported, queued, skipped },
        tone: 'info',
      };
    }
  }
}

/** The `stopped` line of a failed import, when it got through part of the workouts. */
export function stoppedNotice(result: ImportResult): HealthNotice | null {
  if (result.kind !== 'error' || result.imported + result.queued === 0) return null;
  return {
    key: 'mobile.health.result.stopped',
    values: { imported: result.imported, queued: result.queued },
    tone: 'info',
  };
}
