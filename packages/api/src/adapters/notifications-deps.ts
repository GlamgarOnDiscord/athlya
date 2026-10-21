/**
 * Compose the {@link HandleEventDeps} bundle consumed by
 * {@link import('@athlya/notifications').handleEvent}.
 *
 * Slice P0 / issue #60 — wires the notifications consumer in the
 * Worker queue dispatcher so `reservation.*` and
 * `billing.subscription.failed` events are no longer silently acked.
 *
 * Ports wiring:
 *
 *   - `dedup`       — Upstash Redis `SET key value NX EX ttl`.
 *   - `recipients`  — `notification_recipient` service function (migration 0032).
 *   - `branding`   : `notification_studio_branding` service function
 *                     (migration 0053): colors, logo, Athlya mention and
 *                     the studio's activated sending domain.
 *   - `email`       — Resend transport (`RESEND_API_KEY`). Dev-only
 *                     no-op when the key is absent; staging/production
 *                     throw so the queue retries instead of silently
 *                     dropping transactional emails.
 *   - `push`        — Expo push endpoint (`exp.host`) with retry.
 *   - `logger`      — console-backed structured shim.
 *
 * The function is pure: no I/O at construction time, only closure
 * setup. Runtime calls happen inside the consumer.
 */

import { getOrCreateDbHttp, getOrCreateRedis } from './deps-cache.js';
import { fetchWithRetry } from './fetch-retry.js';
import { queryRows, serviceFn } from './service-functions.js';

import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbAny } from '@athlya/db/client';
import type {
  BrandingRepo,
  DedupStore,
  EmailBranding,
  EmailSender,
  HandleEventDeps,
  Logger,
  PushSender,
  Recipient,
  RecipientRepo,
} from '@athlya/notifications';

/* ------------------------------------------------------------------ */
/*  Dedup store                                                        */
/* ------------------------------------------------------------------ */

const NOTIFICATIONS_DEDUP_PREFIX = 'notifications:seen';

function buildDedupStore(env: AthlyaBindings): DedupStore {
  const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
  const keyOf = (eventId: string) => `${NOTIFICATIONS_DEDUP_PREFIX}:${eventId}`;

  return {
    async tryAcquire(eventId, ttlSec) {
      const response = await redis.set(keyOf(eventId), '1', {
        nx: true,
        ex: ttlSec,
      });
      return response === 'OK';
    },
    async release(eventId) {
      await redis.del(keyOf(eventId));
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Recipient lookup                                                   */
/* ------------------------------------------------------------------ */

export function buildRecipientRepo(db: AthlyaDbAny): RecipientRepo {
  return {
    async getRecipient(userId): Promise<Recipient | null> {
      // The queue consumer has no tenant claims, so the recipient is
      // resolved through the `notification_recipient` SECURITY DEFINER
      // function (migration 0032, issue #224) rather than raw `users` /
      // `push_tokens` reads that FORCE RLS would hide from `athlya_app`.
      const rows = await queryRows<{
        id: string;
        email: string | null;
        consents: Recipient['consents'];
        push_tokens: string[] | null;
      }>(db, serviceFn.notificationRecipient(userId));
      const user = rows[0];
      if (user === undefined) return null;

      return {
        userId: user.id,
        email: user.email,
        pushTokens: user.push_tokens ?? [],
        consents: user.consents,
        // Locale column is not in users yet; FR is product default.
        locale: 'fr',
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Studio branding                                                    */
/* ------------------------------------------------------------------ */

export function buildBrandingRepo(db: AthlyaDbAny): BrandingRepo {
  return {
    async getBranding(userId): Promise<EmailBranding | null> {
      const rows = await queryRows<{
        studio_name: string;
        brand_color: string;
        brand_logo_light: string | null;
        hide_athlya_branding: boolean;
        email_domain: string | null;
      }>(db, serviceFn.notificationStudioBranding(userId));
      const row = rows[0];
      if (row === undefined) return null;
      return {
        studioName: row.studio_name,
        brandColor: row.brand_color,
        logoUrl: row.brand_logo_light,
        hideAthlyaBranding: row.hide_athlya_branding,
        emailDomain: row.email_domain,
      };
    },
  };
}

/**
 * Display name for a `From` header: no quotes, angle brackets,
 * backslashes or line breaks (header injection), bounded length.
 */
export function senderDisplayName(name: string): string {
  return name
    .replace(/["<>\\\r\n]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 64);
}

/* ------------------------------------------------------------------ */
/*  Email sender (Resend)                                              */
/* ------------------------------------------------------------------ */

function buildEmailSender(env: AthlyaBindings, logger: Logger): EmailSender {
  const apiKey = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
  const fromAddress =
    ((env as { RESEND_FROM?: string }).RESEND_FROM?.length ?? 0) > 0
      ? (env as { RESEND_FROM: string }).RESEND_FROM
      : 'Athlya <noreply@athlya.app>';

  if (apiKey === undefined || apiKey === '') {
    if (env.ENVIRONMENT === 'dev') {
      return {
        send(message) {
          logger.warn('notifications.email.resend_missing_key', {
            env: env.ENVIRONMENT,
            to: message.to,
            subject: message.subject,
          });
          return Promise.resolve();
        },
      };
    }

    return {
      send() {
        throw new Error('RESEND_API_KEY missing in non-dev env');
      },
    };
  }

  return {
    async send(message) {
      const response = await fetchWithRetry('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from:
            message.sender === undefined
              ? fromAddress
              : `"${senderDisplayName(message.sender.name)}" <noreply@${message.sender.domain}>`,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
      if (!response.ok) {
        throw new Error(`notifications email transport failed (HTTP ${String(response.status)})`);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Push sender (Expo)                                                 */
/* ------------------------------------------------------------------ */

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

function buildPushSender(logger: Logger): PushSender {
  return {
    async send(message) {
      for (let i = 0; i < message.tokens.length; i += EXPO_BATCH_SIZE) {
        const chunk = message.tokens.slice(i, i + EXPO_BATCH_SIZE);
        const payload = chunk.map((token) => ({
          to: token,
          title: message.title,
          body: message.body,
          ...(message.data !== undefined ? { data: message.data } : {}),
        }));

        const response = await fetchWithRetry(EXPO_PUSH_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`notifications push transport failed (HTTP ${String(response.status)})`);
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          logger.warn('notifications.push.invalid_response_json', {
            size: chunk.length,
          });
          continue;
        }

        const tickets =
          typeof parsed === 'object' &&
          parsed !== null &&
          'data' in parsed &&
          Array.isArray(parsed.data)
            ? parsed.data
            : [];

        for (const ticket of tickets) {
          if (
            typeof ticket === 'object' &&
            ticket !== null &&
            (ticket as { status?: unknown }).status === 'error'
          ) {
            logger.warn('notifications.push.ticket_error', {
              details:
                typeof (ticket as { details?: unknown }).details === 'object' &&
                (ticket as { details?: unknown }).details !== null
                  ? (ticket as { details: Record<string, unknown> }).details
                  : undefined,
              message:
                typeof (ticket as { message?: unknown }).message === 'string'
                  ? (ticket as { message: string }).message
                  : undefined,
            });
          }
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Public builder                                                     */
/* ------------------------------------------------------------------ */

export function buildNotificationsDeps(env: AthlyaBindings): HandleEventDeps {
  const db = getOrCreateDbHttp(env.DB_URL);
  const logger: Logger = {
    info: (msg, meta) => {
      console.info(`[notifications] ${msg}`, meta ?? {});
    },
    warn: (msg, meta) => {
      console.warn(`[notifications] ${msg}`, meta ?? {});
    },
    error: (msg, meta) => {
      console.error(`[notifications] ${msg}`, meta ?? {});
    },
  };

  return {
    dedup: buildDedupStore(env),
    recipients: buildRecipientRepo(db),
    branding: buildBrandingRepo(db),
    email: buildEmailSender(env, logger),
    push: buildPushSender(logger),
    logger,
  };
}
