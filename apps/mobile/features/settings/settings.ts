/**
 * Settings screen logic — task 11.11 (Requirements 4.1, 5.1) plus the
 * biometric unlock toggle (Requirement 1.7) and the "rejected changes"
 * view over the offline queue's dead letters.
 *
 * RGPD export and deletion call the same endpoints as the web app:
 * `POST /v1/members/me/export` and `DELETE /v1/auth/me`. Both are online
 * only (never queued): the member has to see whether they went through.
 */
import { ExportJobResponseSchema } from '@athlya/shared/schemas/api';

import { BOOK_CLASS_KIND } from '../classes/classes-controller';
import { toErrorModel, type ErrorModel } from '../errors';
import { CANCEL_RESERVATION_KIND } from '../reservations/reservations-controller';
import { LOG_SESSION_KIND } from '../workouts/workout-form';

import type { ApiClient } from '../../infrastructure/api/client';
import type { TokenStore } from '../../infrastructure/auth/token-store';
import type { UuidV4Generator } from '../../infrastructure/ids';
import type { DeadLetter, MutationQueue } from '../../infrastructure/sync/queue';
import type { SyncController } from '../../infrastructure/sync/sync-controller';
import type { TranslationKeys } from '@athlya/shared/i18n';

/* ------------------------------ biometrics ------------------------ */

/**
 * Turns the biometric unlock on or off and resolves the state to render:
 * enabling resolves `false` when biometrics are unavailable or the prompt
 * was declined, so the switch never shows a protection that is not active.
 */
export async function toggleBiometricUnlock(
  tokenStore: Pick<TokenStore, 'setBiometricUnlockEnabled'>,
  enabled: boolean,
): Promise<boolean> {
  try {
    return await tokenStore.setBiometricUnlockEnabled(enabled);
  } catch {
    return false;
  }
}

/* ------------------------------ rejected changes ------------------ */

const KIND_KEYS: Readonly<Record<string, TranslationKeys>> = {
  [BOOK_CLASS_KIND]: 'mobile.settings.rejected.kinds.bookClass',
  [CANCEL_RESERVATION_KIND]: 'mobile.settings.rejected.kinds.cancelReservation',
  [LOG_SESSION_KIND]: 'mobile.settings.rejected.kinds.logSession',
};

export interface RejectedChangeItem {
  readonly id: string;
  readonly kindKey: TranslationKeys;
  readonly status: number;
  readonly problemCode: string | null;
  readonly failedAt: string;
}

/**
 * Rows of the "rejected changes" view, most recent first. Pass
 * `queue.deadLetters(userId)`: it only returns that user's entries.
 */
export function rejectedChanges(letters: readonly DeadLetter[]): readonly RejectedChangeItem[] {
  return letters
    .map((letter) => ({
      id: letter.id,
      kindKey: KIND_KEYS[letter.kind] ?? 'mobile.settings.rejected.kinds.other',
      status: letter.status,
      problemCode: letter.problemCode ?? null,
      failedAt: letter.failedAt,
    }))
    .sort((a, b) => Date.parse(b.failedAt) - Date.parse(a.failedAt));
}

/* ------------------------------ RGPD ------------------------------ */

export interface RgpdDeps {
  readonly api: Pick<ApiClient, 'post' | 'del'>;
  readonly uuid: UuidV4Generator;
}

export type ExportResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly error: ErrorModel };

/** Requests the Article 15/20 export; the archive link arrives by email. */
export async function requestDataExport(deps: RgpdDeps): Promise<ExportResult> {
  try {
    const raw = await deps.api.post<unknown>(
      '/v1/members/me/export',
      {},
      {
        idempotencyKey: deps.uuid(),
      },
    );
    return { ok: true, jobId: ExportJobResponseSchema.parse(raw).jobId };
  } catch (error) {
    return {
      ok: false,
      error: toErrorModel(error, { 429: 'mobile.settings.export.alreadyRequested' }),
    };
  }
}

/** The typed confirmation must match exactly, as on the web app. */
export function isDeleteConfirmed(typed: string, confirmWord: string): boolean {
  return typed.trim() === confirmWord;
}

export interface DeleteAccountDeps extends RgpdDeps {
  readonly tokenStore: Pick<TokenStore, 'clear'>;
  readonly sync: Pick<SyncController, 'refreshOwner'>;
  readonly queue: Pick<
    MutationQueue,
    'pendingFor' | 'remove' | 'deadLetters' | 'discardDeadLetter'
  >;
}

export type DeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: ErrorModel };

/**
 * Article 17 deletion. Once the API accepted it, the device forgets the
 * account too: its queued and rejected changes (they could never be sent
 * again) and the session.
 */
export async function deleteAccount(
  deps: DeleteAccountDeps,
  userId: string,
): Promise<DeleteResult> {
  try {
    await deps.api.del<unknown>('/v1/auth/me', { idempotencyKey: deps.uuid() });
  } catch (error) {
    return { ok: false, error: toErrorModel(error) };
  }
  for (const mutation of deps.queue.pendingFor(userId)) deps.queue.remove(mutation.id);
  for (const letter of deps.queue.deadLetters(userId)) {
    deps.queue.discardDeadLetter(letter.id, userId);
  }
  await deps.tokenStore.clear();
  await deps.sync.refreshOwner();
  return { ok: true };
}
