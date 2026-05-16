/**
 * Redis-backed `SessionStore` implementation for `@athlya/auth`.
 *
 * Sprint-2 SP2.1 (Vague 29) — refresh atomicity + family-tree revoke
 * --------------------------------------------------------------------
 * Audit findings resolved:
 *   • S2-002 [CRITICAL][PROD-RISK] — the previous `rotate()` did
 *     `GET → SET → SADD → SREM → DEL` over five HTTP round-trips,
 *     leaving a race window where two parallel refreshes of the same
 *     stolen token could both succeed and fork the session into
 *     divergent rotation chains. The new implementation runs the
 *     swap as a single Lua script via `redis.eval()` — `GETDEL` the
 *     old payload, `SET NX` the new, then update the index sets in
 *     the same atomic block. A losing concurrent caller gets back
 *     `kind: 'unknown'` (Lua reads an empty old key on the second
 *     attempt) and the auth service throws `token_invalid`.
 *
 *   • S2-004 [HIGH][PROD-RISK] — when an already-rotated refresh
 *     token is presented (near-certain theft signal), we now revoke
 *     every descendant sid in the rotation family rooted at
 *     `rootSid`. Two extra Redis keys back the family tree:
 *
 *       - `auth:family:<rootSid>`     SET of every sid that ever
 *                                     belonged to the family.
 *       - `auth:sid_to_root:<sid>`    STRING pointer from a sid back
 *                                     to its rootSid; lets the
 *                                     reuse-detection lookup
 *                                     succeed without re-reading
 *                                     the original payload.
 *
 *     The discriminated `RotateResult` exposed to `service.refresh`
 *     drives the family revoke + audit + event flow on the auth
 *     side; this adapter is responsible only for the storage shape.
 *
 * Storage layout (post-SP2.1)
 * --------------------------------------------------------------------
 *   `auth:sid:<sid>`              JSON `{ userId, expiresAt, rootSid,
 *                                 parentSid }`. TTL aligned on
 *                                 `expiresAt`.
 *   `auth:user:<userId>:sids`     SET of currently-live sids. Used
 *                                 by `revokeAllForUser` for the
 *                                 fan-out delete on account deletion.
 *   `auth:family:<rootSid>`       SET of every sid that ever
 *                                 belonged to the family — including
 *                                 already-rotated ones, so reuse can
 *                                 still be detected after the per-sid
 *                                 row has been deleted.
 *   `auth:sid_to_root:<sid>`      STRING `<rootSid>`. Permanent
 *                                 pointer from any sid (live OR
 *                                 already-rotated) to the family
 *                                 root, with TTL aligned on the
 *                                 longest possible refresh lifetime
 *                                 + a 7-day forensic grace window
 *                                 (so reuse on a freshly-expired
 *                                 token still triggers the family
 *                                 revoke).
 *
 * Backward compatibility
 * --------------------------------------------------------------------
 * Payloads written before SP2.1 do not carry `rootSid` /
 * `parentSid`. The reader treats a missing `rootSid` as
 * `rootSid = sid` (self-rooted, no detectable family) and
 * `parentSid = null`. This keeps every refresh token issued in the
 * 30-day window straddling the deploy operational; new rotations
 * stamp the family fields immediately so the protection kicks in
 * the moment a session rotates.
 *
 * @see Requirements 1.5, 2.2, 5.1.
 * @see docs/security/audit-S2-auth.md S2-002, S2-004
 */

import type { RotateResult, SessionStore } from '@athlya/auth';
import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Key helpers                                                        */
/* ------------------------------------------------------------------ */

function sidKey(sid: string): string {
    return `auth:sid:${sid}`;
}

function userSidsKey(userId: string): string {
    return `auth:user:${userId}:sids`;
}

function familyKey(rootSid: string): string {
    return `auth:family:${rootSid}`;
}

function sidToRootKey(sid: string): string {
    return `auth:sid_to_root:${sid}`;
}

/**
 * TTL applied to `auth:sid_to_root:*` pointers — the longest possible
 * refresh-token lifetime (30 days) plus a 7-day forensic grace
 * window. A sid_to_root pointer outliving its sid by 7 days lets the
 * reuse detector still fire when an attacker replays a token that
 * expired the day before.
 */
const SID_TO_ROOT_TTL_SEC = 37 * 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/*  Lua scripts                                                        */
/* ------------------------------------------------------------------ */

/**
 * Atomic rotate — Sprint-2 SP2.1, Finding S2-002.
 *
 * KEYS layout:
 *   [1] auth:sid:<oldSid>
 *   [2] auth:sid:<newSid>
 *   [3] auth:user:<userId>:sids   (passed empty when userId not yet known;
 *                                  the caller falls back to a no-op SADD/SREM
 *                                  in that branch — see below)
 *   [4] auth:family:<rootSid>     (similarly conditional)
 *   [5] auth:sid_to_root:<oldSid>
 *   [6] auth:sid_to_root:<newSid>
 *
 * ARGV layout:
 *   [1] newPayloadJson
 *   [2] ttlSec
 *   [3] oldSid
 *   [4] newSid
 *   [5] rootSid
 *   [6] sidToRootTtlSec
 *
 * Returns one of:
 *   {0, ''}                 — old sid absent (race lost OR forged OR
 *                             expired); caller must check sid_to_root
 *                             outside Lua to differentiate "unknown"
 *                             from "reuse_detected".
 *   {1, oldPayloadJson}     — happy path, swap committed.
 *
 * Returning a status flag in the first slot keeps the Upstash REST
 * driver happy (Lua arrays cross the wire as JS arrays of strings;
 * `0` / `1` discriminator avoids the boolean-coercion ambiguity that
 * some clients have with `false` returns).
 */
const ROTATE_LUA = `
local oldPayload = redis.call('GETDEL', KEYS[1])
if not oldPayload then
  return {0, ''}
end

local setOk = redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]), 'NX')
if not setOk then
  -- Best-effort restore of the old payload so we leave the world
  -- self-consistent. Lua atomicity guarantees no observer ever saw
  -- the intermediate state.
  redis.call('SET', KEYS[1], oldPayload, 'EX', tonumber(ARGV[2]))
  return {0, ''}
end

if KEYS[3] ~= '' then
  redis.call('SADD', KEYS[3], ARGV[4])
  redis.call('SREM', KEYS[3], ARGV[3])
end

if KEYS[4] ~= '' then
  redis.call('SADD', KEYS[4], ARGV[4])
end

redis.call('SET', KEYS[6], ARGV[5], 'EX', tonumber(ARGV[6]))

return {1, oldPayload}
`;

/* ------------------------------------------------------------------ */
/*  Payload narrowing                                                  */
/* ------------------------------------------------------------------ */

interface SessionPayload {
    readonly userId: string;
    readonly expiresAt: string;
    readonly rootSid: string;
    readonly parentSid: string | null;
}

/**
 * Parse a Redis `auth:sid:*` payload, applying the SP2.1 backward-
 * compat rule (missing `rootSid` → fallback to the sid itself, so
 * the session is treated as self-rooted with no detectable family).
 *
 * Returns `null` on any structural problem so callers can fail
 * closed.
 */
function parsePayload(raw: string, sid: string): SessionPayload | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    const userId = obj['userId'];
    const expiresAt = obj['expiresAt'];
    if (typeof userId !== 'string' || userId === '') return null;
    if (typeof expiresAt !== 'string' || expiresAt === '') return null;

    // SP2.1 fields. `rootSid` defaults to the sid itself when absent
    // (legacy payload pre-Vague 29). `parentSid` defaults to `null`
    // (top of the family tree) for the same reason.
    const rootSidRaw = obj['rootSid'];
    const rootSid =
        typeof rootSidRaw === 'string' && rootSidRaw !== ''
            ? rootSidRaw
            : sid;
    const parentSidRaw = obj['parentSid'];
    const parentSid =
        typeof parentSidRaw === 'string' && parentSidRaw !== ''
            ? parentSidRaw
            : null;

    return { userId, expiresAt, rootSid, parentSid };
}

function serializePayload(payload: SessionPayload): string {
    return JSON.stringify(payload);
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `SessionStore` bound to an Upstash Redis
 * client. Safe to hold one instance per Worker isolate.
 */
export function createRedisSessionStore(redis: Redis): SessionStore {
    return {
        async create(userId, sid, expiresAt) {
            const ttlSec = ttlFromExpiresAt(expiresAt);
            const payload: SessionPayload = {
                userId,
                expiresAt: expiresAt.toISOString(),
                rootSid: sid,
                parentSid: null,
            };
            // Per-sid record + user index. Family seed + sid_to_root
            // pointer are added next so the rotation chain is ready
            // for both happy-path rotation AND eventual reuse
            // detection (which needs the sid_to_root pointer to
            // outlive the per-sid record).
            await redis.set(sidKey(sid), serializePayload(payload), {
                ex: ttlSec,
            });
            await redis.sadd(userSidsKey(userId), sid);
            await redis.sadd(familyKey(sid), sid);
            await redis.set(sidToRootKey(sid), sid, {
                ex: SID_TO_ROOT_TTL_SEC,
            });
        },

        async rotate(oldSid, newSid, newExpiresAt): Promise<RotateResult> {
            // Step 1 — peek at the old payload BEFORE the Lua call
            // so we can populate KEYS[3] (user index) and KEYS[4]
            // (family index) with the right scope. The peek itself
            // is non-destructive; the Lua call below is the
            // atomic-and-destructive part.
            //
            // We can NOT include this lookup inside the Lua script
            // because the user-index and family-index keys are
            // themselves keyed on values found INSIDE the payload —
            // Redis Cluster compatibility requires KEYS to be
            // declared upfront. The atomicity guarantee we care
            // about (no two concurrent rotations both succeeding)
            // is local to KEYS[1]/KEYS[2] and is preserved by
            // GETDEL+SETNX.
            const peek = await redis.get<string>(sidKey(oldSid));
            let userIdForIndex = '';
            let rootSidForIndex = '';
            let payloadForNew: SessionPayload | null = null;
            if (peek !== null) {
                const peekedPayload = parsePayload(peek, oldSid);
                if (peekedPayload !== null) {
                    userIdForIndex = peekedPayload.userId;
                    rootSidForIndex = peekedPayload.rootSid;
                    payloadForNew = {
                        userId: peekedPayload.userId,
                        expiresAt: newExpiresAt.toISOString(),
                        rootSid: peekedPayload.rootSid,
                        parentSid: oldSid,
                    };
                }
            }

            // If the peek failed to find / parse the old payload,
            // we still have to attempt the Lua call so any
            // concurrent rotation that has *just* happened gets
            // observed. The Lua call returns {0, ''} in that case
            // and the reuse-detection branch below decides between
            // 'unknown' and 'reuse_detected'.
            if (payloadForNew === null) {
                payloadForNew = {
                    userId: '',
                    expiresAt: newExpiresAt.toISOString(),
                    rootSid: newSid,
                    parentSid: oldSid,
                };
            }

            const ttlSec = ttlFromExpiresAt(newExpiresAt);
            const newPayloadJson = serializePayload(payloadForNew);

            // Build the KEYS array. Conditional indices land as
            // empty strings; the Lua script skips the SADD/SREM
            // when KEYS[3]/KEYS[4] are empty.
            const result = (await redis.eval(
                ROTATE_LUA,
                [
                    sidKey(oldSid),
                    sidKey(newSid),
                    userIdForIndex !== '' ? userSidsKey(userIdForIndex) : '',
                    rootSidForIndex !== '' ? familyKey(rootSidForIndex) : '',
                    sidToRootKey(oldSid),
                    sidToRootKey(newSid),
                ],
                [
                    newPayloadJson,
                    String(ttlSec),
                    oldSid,
                    newSid,
                    rootSidForIndex !== '' ? rootSidForIndex : newSid,
                    String(SID_TO_ROOT_TTL_SEC),
                ],
            ));

            // Defensive narrowing — Upstash returns `unknown` on
            // `eval`. If the driver ever surfaces something we did
            // not expect, treat as `unknown` and let the caller
            // fail closed.
            if (
                !Array.isArray(result) ||
                result.length < 2 ||
                typeof result[0] !== 'number'
            ) {
                return { kind: 'unknown' };
            }

            if (result[0] === 1) {
                // Happy path — Lua committed the swap. The peek
                // populated the user/family fields; the script also
                // wrote the sid_to_root pointer for the new sid.
                return {
                    kind: 'ok',
                    userId: userIdForIndex,
                    rootSid: rootSidForIndex !== '' ? rootSidForIndex : newSid,
                };
            }

            // Lua returned {0, ...}. Either the old sid never
            // existed (forged token / expired) OR it was already
            // rotated out of the family. The sid_to_root pointer
            // outlives the per-sid record by 7 days, so a hit here
            // is the canonical reuse signal.
            const root = await redis.get<string>(sidToRootKey(oldSid));
            if (root === null || root === '') {
                return { kind: 'unknown' };
            }

            // Reuse detected. Resolve the userId so the caller can
            // emit the audit row + suspicious event. Any sid in the
            // family pointing back to the same root has the userId;
            // we read the family set and pick any survivor's
            // payload — failing that, we fall back to peek's
            // userId (if it happened to land), and ultimately
            // return an empty userId which the auth service
            // already handles via the strict actorId guard.
            const resolvedUserId =
                userIdForIndex !== ''
                    ? userIdForIndex
                    : await resolveUserIdFromFamily(redis, root);

            return {
                kind: 'reuse_detected',
                userId: resolvedUserId,
                rootSid: root,
            };
        },

        async revoke(sid) {
            // Look up the userId BEFORE deleting the payload so we
            // can remove the sid from the user's live-sid set too.
            const existing = await redis.get<string>(sidKey(sid));
            await redis.del(sidKey(sid));
            // Note: we deliberately DO NOT delete the family or
            // sid_to_root entries here. A user-initiated logout
            // takes one sid offline but the family must keep
            // memorising it so a stolen-then-replayed copy still
            // triggers reuse_detected on the next rotation
            // attempt. The sid_to_root TTL eventually reaps it.
            if (existing === null) return;
            const parsed = parsePayload(existing, sid);
            if (parsed !== null) {
                await redis.srem(userSidsKey(parsed.userId), sid);
            }
        },

        async revokeAllForUser(userId) {
            const sids = await redis.smembers(userSidsKey(userId));
            if (sids.length === 0) return;
            // `DEL` accepts N keys; we pass every per-sid payload plus
            // the index itself in a single call to minimise HTTP
            // round-trips. We do NOT clear the family / sid_to_root
            // here for the same reason as `revoke` — reuse signal
            // outlives the live ledger.
            const perSidKeys = sids.map((s) => sidKey(s));
            await redis.del(...perSidKeys, userSidsKey(userId));
        },

        async revokeFamilyByRootSid(rootSid) {
            // Read every sid that ever belonged to the family,
            // including already-rotated ones. The fan-out delete
            // covers per-sid rows (no-op for the rotated ones —
            // already gone), the family set itself, and every
            // sid_to_root pointer in the family.
            const familySids = await redis.smembers(familyKey(rootSid));
            const keysToDelete: string[] = [familyKey(rootSid)];

            // Best-effort userId discovery so we can also clean up
            // the user-index set entry. The first live sid we find
            // gives us the userId; if every sid in the family is
            // already rotated/expired we skip the user-set cleanup
            // and rely on its own TTL.
            let userId = '';
            for (const sid of familySids) {
                keysToDelete.push(sidKey(sid));
                keysToDelete.push(sidToRootKey(sid));
                if (userId === '') {
                    const payload = await redis.get<string>(sidKey(sid));
                    if (payload !== null) {
                        const parsed = parsePayload(payload, sid);
                        if (parsed !== null) userId = parsed.userId;
                    }
                }
            }

            if (keysToDelete.length > 0) {
                await redis.del(...keysToDelete);
            }
            if (userId !== '' && familySids.length > 0) {
                await redis.srem(userSidsKey(userId), ...familySids);
            }
        },

        async exists(sid) {
            const count = await redis.exists(sidKey(sid));
            return count === 1;
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Compute a Redis `EX` TTL (seconds) from the session's wall-clock
 * expiry. Clamped to >= 1 so we never pass 0 (immediate expiry) or
 * negative values (Upstash returns an error).
 */
function ttlFromExpiresAt(expiresAt: Date): number {
    const diff = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    return Math.max(1, diff);
}

/**
 * Best-effort userId lookup walking the family set. Returns `''`
 * when every sid in the family is already gone — the auth service
 * is responsible for handling the empty-userId branch (which
 * surfaces as `actorId = ''` in the audit row, distinguishable
 * from a real userId for forensic purposes).
 */
async function resolveUserIdFromFamily(
    redis: Redis,
    rootSid: string,
): Promise<string> {
    const familySids = await redis.smembers(familyKey(rootSid));
    for (const sid of familySids) {
        const payload = await redis.get<string>(sidKey(sid));
        if (payload === null) continue;
        const parsed = parsePayload(payload, sid);
        if (parsed !== null) return parsed.userId;
    }
    return '';
}
