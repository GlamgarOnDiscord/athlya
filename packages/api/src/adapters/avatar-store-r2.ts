/**
 * Cloudflare R2-backed `AvatarStore` for `@athlya/members/cascade`.
 *
 * Implements the {@link import('@athlya/members').AvatarStore} port:
 * a single `deleteAvatar(userId)` method that purges every R2 object
 * under the `avatars/{userId}/` prefix. Best-effort by contract — a
 * transient R2 failure is logged and swallowed by the cascade
 * orchestrator so the SQL deletions can still complete (Req 5.4 +
 * see the explicit `try/catch` around `avatars.deleteAvatar` in
 * `packages/members/src/cascade.ts`).
 *
 * Mode dégradé (binding absent)
 * -----------------------------
 * The `AVATARS_BUCKET` Worker binding is **optional** at the type
 * level (see `types.ts`). Until the R2 bucket is provisioned via
 * `wrangler r2 bucket create athlya-avatars-{env}` (cf. Vague 26
 * runbook), the binding is `undefined` at runtime. This adapter
 * detects that and:
 *
 *   1. Logs a `console.warn` line so the missing infra is loud in
 *      Tail Workers.
 *   2. Resolves the promise without throwing, so the cascade
 *      orchestrator's best-effort branch records a no-op.
 *
 * Pattern matches the B9 Stripe degraded mode (`billing-deps.ts`)
 * — the absence of a Cloudflare binding is treated as a
 * configuration warning, not an error, so the rest of the cascade
 * (SQL row deletion, audit anonymisation scheduling) keeps the
 * RGPD-required compliance window.
 *
 * Slice 1.3 — Sprint 1 — resolves audit finding S5-002 (CRITICAL
 * RGPD Article 17 cascade not wired). See `docs/security/audit-S5-rgpd.md`.
 */

import type { AvatarStore } from '@athlya/members';
import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * Maximum number of objects to enumerate in a single `list()` call.
 * Cloudflare's R2 API caps this at 1000; we use a smaller batch so
 * the worst case (a user who somehow accumulated many avatar
 * variants over years) doesn't burn the consumer's whole CPU budget
 * in one queue tick.
 */
const LIST_BATCH_SIZE = 100;

/**
 * Build the R2 key prefix for a user's avatar objects.
 *
 * Exported so tests can assert the exact prefix used and so a
 * future "list all avatars" admin job can reuse the convention.
 */
export function avatarPrefix(userId: string): string {
    return `avatars/${userId}/`;
}

/**
 * Factory — produces an {@link AvatarStore} bound to an optional
 * R2 binding. When `bucket` is `undefined`, every method logs a
 * warning and resolves without I/O (mode dégradé).
 */
export function createR2AvatarStore(
    bucket: R2Bucket | undefined,
    options: { readonly env?: string } = {},
): AvatarStore {
    return {
        async deleteAvatar(userId) {
            if (bucket === undefined) {
                console.warn(
                    '[avatar-store-r2] AVATARS_BUCKET binding missing — skipping avatar purge (mode dégradé)',
                    {
                        userId,
                        env: options.env ?? 'unknown',
                    },
                );
                return;
            }

            // Enumerate every object under `avatars/{userId}/` and
            // delete in bounded batches. R2 `delete` accepts an
            // array — one round trip per batch is sufficient even
            // for the pathological case (single user with hundreds
            // of avatar variants).
            const prefix = avatarPrefix(userId);
            let cursor: string | undefined;
            do {
                const listing = await bucket.list({
                    prefix,
                    limit: LIST_BATCH_SIZE,
                    ...(cursor === undefined ? {} : { cursor }),
                });
                if (listing.objects.length > 0) {
                    const keys = listing.objects.map((o) => o.key);
                    await bucket.delete(keys);
                }
                // R2's `truncated` discriminator narrows the shape:
                // when `true`, `cursor` is present; when `false`, the
                // listing is complete and we exit the loop.
                if (listing.truncated) {
                    cursor = listing.cursor;
                } else {
                    cursor = undefined;
                }
            } while (cursor !== undefined);
        },
    };
}
