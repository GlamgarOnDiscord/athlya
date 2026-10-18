# Athlya — Event Bus runbook

> Slice **B6** (Backend hardening — Outbox & event reliability).
>
> Couvre : transactional outbox, drain worker, dead-letter queue,
> dedup côté consumer. Lecture obligatoire pour toute astreinte qui
> touche au pipeline d'événements.

## 1. Architecture

```
domain service ─► publish() ─┬─► EVENTS_QUEUE.send(envelope)         (best-effort)
                             │
                             └─► insertOutbox(tx, payload)           (durable)
                                          │
                                          ▼
                              ┌────────── outbox table ──────────┐
                              │ status = published_at IS NULL    │
                              └──────────────┬───────────────────┘
                                             │
                              cron 1 min     │
                                             ▼
                                runScheduledDrain()
                                  → claimBatch (FOR UPDATE SKIP LOCKED, 100 rows)
                                  → queue.send(envelope) per row
                                  → markPublished(id) per row
                                             │
                                             ▼
                              ┌──────── EVENTS_QUEUE ────────┐
                              │ Cloudflare Queues, eu-west   │
                              └──────────────┬───────────────┘
                                             │ at-least-once
                                             ▼
                                     consumer batch
                                  → assertNotSeen(redis, eventId, 86400)
                                  → applySideEffect(event)
                                             │
                  5 retries ratés ────────────┼─► athlya-events-dlq
                                             │     (drain ↓ tracker)
                                             ▼
                                handleDlqBatch → Redis tracker
                                          (dlq:entry:<id> + dlq:pending)
                                             │
                                             ▼
                              admin /admin/dlq/* (replay / discard)
```

Modules concernés (chemins relatifs au repo) :

- Producteur : `packages/api/src/events/publish.ts` — protocole
  outbox-first, retry budget 3 + backoff exponentiel par défaut.
- Drain worker pur : `packages/api/src/events/drain-worker.ts` —
  framework-free, testable sans CF runtime.
- Adapter cron : `packages/api/src/events/drain-scheduled.ts` —
  bridge `ScheduledEvent` ↔ `drainOutbox`, transaction par cycle.
- Worker entrypoint : `packages/api/src/worker.ts` — câble `fetch`,
  `scheduled` (drain) et `queue` (dispatch RGPD + notifications +
  DLQ handler).
- DLQ tracker : `packages/api/src/events/drain-dlq.ts`.
- Dedup consumer : `packages/api/src/events/dedup.ts`.

## 2. Drain worker — wiring + cadence

### 2.1 Cadence configurée

`packages/api/wrangler.toml` § `[triggers]` :

```toml
[triggers]
crons = ["* * * * *"]
```

Cloudflare Cron Triggers ont une **résolution minimum d'1 minute**.
Le design doc original cible 30 s ; on accepte le tradeoff parce que :

- Le batch drain est dimensionné à 100 lignes (`DEFAULT_BATCH_SIZE`)
  — assez pour absorber le débit cible (~ 10 events/min en steady
  state) en une seule passe.
- Les consumers dédupent sur `event.id` pour 24 h (Req 17.4) donc une
  redelivery par le drain est sans effet de bord.
- En cas de pic, plusieurs cycles consécutifs vident la file.

La cadence est dupliquée dans **chaque environnement** (`[env.dev]`,
`[env.staging]`, `[env.production]`) parce que certaines versions de
Wrangler 3.x n'héritent pas du `[triggers]` top-level dans les envs
nommés. Vérifier que les 4 sections (top-level + 3 envs) portent la
même expression cron avant tout `wrangler deploy`.

### 2.2 Vérification en prod

Tail du worker filtré sur les logs du drain :

```bash
wrangler tail athlya-api-production --env production --format pretty \
  | grep -E '\[drain\]|outbox drain'
```

On doit voir, **toutes les 60 s minimum** :

```
[drain] outbox drain: empty batch    {"batchSize":100}
```

…ou en cas de trafic :

```
[drain] outbox drain: claimed rows   {"count":5,"batchSize":100}
[drain] outbox drain: batch complete {"processed":5,"succeeded":5,"failed":0,"durationMs":...}
```

### 2.3 Re-trigger manuel

Si on suspecte que le cron ne se déclenche plus (Cloudflare incident,
preview deploy mal câblé, etc.) :

```bash
# Force une exécution du scheduled handler en staging
wrangler dev --env staging --test-scheduled
# puis dans un autre terminal :
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

En prod on ne peut pas faire ça directement — il faut soit :

1. Attendre le prochain tick (≤ 60 s), ou
2. Push un déploiement no-op (`wrangler deploy --env production`) qui
   redéclenche le scheduler côté CF.

### 2.4 Check-list "drain est-il bloqué ?"

Côté Postgres, requête ad-hoc :

```sql
SELECT count(*)                                   AS pending,
       min(occurred_at)                           AS oldest,
       now() - min(occurred_at)                   AS oldest_age,
       max(attempts)                              AS max_attempts
FROM   athlya.outbox
WHERE  published_at IS NULL
  AND  occurred_at < now() - interval '5 minutes';
```

- **`pending = 0`** → drain à jour, rien à faire.
- **`pending > 0` AND `oldest_age > 5 min`** → drain bloqué ou en
  retard. Causes probables :
  1. Le cron ne tourne plus → vérifier `wrangler tail`.
  2. La queue refuse les sends → vérifier le dashboard CF
     (Queues → `athlya-events` → backlog & errors).
  3. La transaction Drizzle ne commit pas (lock contention sur
     `outbox`) → vérifier `pg_stat_activity` pour des sessions
     `idle in transaction` > 5 min.
- **`max_attempts > 10`** → un row précis échoue à chaque cycle.
  Triage : récupérer `id`, regarder `event_type`, et corréler avec
  les warns `outbox drain: queue send failed` du tail. Solution :
  patch côté producer (event mal formé) ou côté consumer (handler
  rejette systématiquement) puis purger manuellement la ligne avec
  `UPDATE outbox SET published_at = now() WHERE id = '<id>'` après
  validation par on-call.

## 3. Dead-Letter Queue (DLQ)

### 3.1 Configuration actuelle

Cloudflare Queues consumer (`packages/api/wrangler.toml`, dupliqué
dans dev/staging/production) :

```toml
[[queues.consumers]]
queue = "athlya-events"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 5
dead_letter_queue = "athlya-events-dlq"

[[queues.consumers]]
queue = "athlya-events-dlq"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
```

### 3.2 Politique de retry

- **Budget primaire** : 5 tentatives consécutives par message avant
  bascule en DLQ. Couvre les blips Upstash/Hyperdrive sans poison
  d'event durablement cassé.
- **Backoff** : Cloudflare Queues utilise un backoff **managed
  exponentiel** côté plateforme (jitter inclus, non-configurable
  module par module en B6). Pour le projet on s'aligne sur le défaut
  CF — la cible documentaire `[1s, 5s, 30s, 5min, 1h]` reste la
  référence design ; un override custom passera par
  `msg.retry({ delaySeconds })` quand on aura les métriques de retry
  réelles (B7).
- **Abandon** : après 5 échecs → message déplacé en DLQ. Le drain
  DLQ (`drain-dlq.ts → handleDlqBatch`) ack chaque message et
  upsert un tracker `dlq:entry:<id>` + `dlq:pending` sur Redis.
- **Budget DLQ-side** : 3 retries internes côté consumer DLQ. Si le
  drain DLQ lui-même échoue 3 fois, c'est un incident plateforme
  (Redis down) — page on-call.
- **Alerte Sentry** : la métrique
  `queue.athlya-events-dlq.messages_pending > 0` pendant ≥ 5 min
  remonte un breadcrumb Sentry via le tail worker (à câbler en B7
  quand l'OTel pipe des métriques business sera en place).

  **Câblage actif (B6.2)** : `handleDlqBatch` (`drain-dlq.ts`) émet
  une `captureException` Sentry par **entrée fraîchement trackée**
  (pas sur les ré-observations, qui sont bruit par construction).
  Chaque alerte porte les tags `queue=athlya-events-dlq`,
  `messageId=<cf-message-id>`, et — quand le payload décode comme
  un envelope domaine — `eventType` + `eventId`. Le client Sentry
  est mis en cache module-scope par `(env, dsn, version)` (mêmes
  bindings `SENTRY_DSN` / `ENVIRONMENT` / `VERSION` que le pipe
  HTTP `onError`). Pas de DSN configuré → fallback `console.error`
  avec le préfixe `[dlq] alert (no Sentry DSN configured)` que les
  Tail Workers / Loki captent.

> **Note B7** : la backoff schedule actuelle est managed CF. Quand
> les métriques OTel auront 1-2 semaines d'historique, ré-évaluer si
> on bascule vers `msg.retry({ delaySeconds })` avec la séquence
> `[1, 5, 30, 300, 3600]`. Voir `tasks.md` Epic B7.4.

### 3.3 Procédure en cas d'alerte DLQ

Voir `packages/api/src/events/dlq.md` § « Runbook (summary) ».
Synthèse :

1. `wrangler queues consumer athlya-events-dlq tail` → capturer ≥ 1
   payload pour triage.
2. Classifier (bug code / bad event / outage downstream).
3. Replay via `POST /admin/dlq/replay/:entryId` (admin-only) une
   fois la cause racine corrigée. Le consumer dedup (Req 17.4)
   absorbe les double-deliveries dans la fenêtre 24 h.
4. Discard via `POST /admin/dlq/discard/:entryId` pour les events
   irrécupérables (loguer dans l'audit).

### 3.4 DLQ setup checklist

À vérifier avant tout `deploy:production` qui touche au pipeline
events :

- [ ] `[[queues.consumers]] dead_letter_queue = "athlya-events-dlq"`
      présent dans **chaque** env nommé.
- [ ] La queue `athlya-events-dlq` (ou `-staging-dlq`) est provisionnée
      Cloudflare-side (un `wrangler deploy` la crée la première fois).
- [ ] La binding producer `EVENTS_DLQ` existe (utilisé pour future
      requeue manuelle).
- [ ] `REDIS_URL` + `REDIS_TOKEN` sont définis comme secrets pour le
      tracker DLQ.
- [ ] Le `queue()` handler de `worker.ts` route bien
      `batch.queue === 'athlya-events-dlq'` vers `handleDlqBatch`.

## 4. Dedup côté consumer

Module : `packages/api/src/events/dedup.ts`.

### 4.1 API

```ts
import { assertNotSeen } from './events/dedup.js';

export async function onEvent(event: AthlyaEvent, env: Env) {
  const fresh = await assertNotSeen(env.redis, event.id);
  if (!fresh) return; // déjà traité, skip silencieux
  await applySideEffect(event);
}
```

- **Clé Redis** : `events:seen:<eventId>`.
- **TTL** : 24 h (`DEFAULT_DEDUP_TTL_SEC = 86_400`). Aligne avec
  Req 17.4. Tout consumer qui veut élargir la fenêtre passe un
  `ttlSec` custom au call-site — **pas** de mutation globale.
- **Atomicité** : `SET … NX EX <ttl>` en un seul round-trip. Pas de
  race entre 2 réplicas qui processent la même redelivery.
- **Idempotence** : `assertNotSeen` est sûr à appeler N fois pour le
  même id — seul le premier appel renvoie `true`.

### 4.2 Quand l'utiliser

- **Tous** les consumers Cloudflare Queues (Notifications, audit,
  billing) doivent l'appeler en première ligne du handler.
- Le drain worker (`drainOutbox`) **n'a pas besoin** de dedup côté
  outbox — l'unique-violation côté DB sur `event_id` (cf. schema
  `outbox`) garantit déjà l'unicité avant publish.
- Le DLQ tracker (`drain-dlq.ts`) fait son propre dedup sur
  `Message.id` (pas sur `event.id`) parce qu'il observe la couche
  message CF, pas la couche domaine.

### 4.3 Runtime impact

Une commande Redis par event consumé (1 `SET NX EX`). Upstash
facture par operation : ~ 10 events/min × 60 × 24 = 14 400 calls/jour
en steady state — bien sous la limite Free tier. Les keys expirent
seules, pas de janitor à câbler.

## 5. Coverage tests outbox → drain → consumer

Slice B6.4 — quels events critiques sont déjà couverts par quels
tests ?

| Event                                          | Producer test                                                                 | Drain test                                                 | Consumer dedup test                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `reservation.created`                          | `publish.test.ts` (envelope valide)                                           | `drain-worker.test.ts` § "claims N rows" (event #1)        | `dedup.test.ts` (générique)                             |
| `reservation.cancelled`                        | `gateway.integration.test.ts` (E2E)                                           | `drain-worker.test.ts` § "claims N rows" (event #2)        | `dedup.test.ts` (générique)                             |
| `reservation.promoted`                         | `gateway.integration.test.ts` (waitlist FIFO)                                 | `drain-worker.test.ts` § "claims N rows" (event #3)        | `dedup.test.ts` (générique)                             |
| `members.export.requested`                     | `packages/members/src/__tests__/export.test.ts`                               | couvert par le path générique (drain est event-type-blind) | `dedup.test.ts` (générique)                             |
| `members.export.completed`                     | `packages/members/src/__tests__/export.test.ts`                               | couvert par le path générique (drain est event-type-blind) | `dedup.test.ts` (générique)                             |
| `reservation.created` (queue dispatch)         | `packages/api/src/__tests__/queue-cascade.test.ts` (route vers notifications) | n/a (dispatcher consumer side)                             | `packages/notifications/src/__tests__/consumer.test.ts` |
| `billing.subscription.failed` (queue dispatch) | couvert par le même routeur consumer (`worker.ts`)                            | n/a (dispatcher consumer side)                             | `packages/notifications/src/__tests__/consumer.test.ts` |
| `auth.password_reset.requested`                | `adapters/auth-runtime.pglite.test.ts` (athlya_app, migration 0043)           | same file (drained row → envelope → consumer)              | `password-reset-delivery.test.ts`                       |

**Décision B6.4** : pas de test integration outbox→drain→consumer
end-to-end ajouté. Justifications :

1. Le drain worker (`drain-worker.ts`) est **event-type-blind** — il
   reconstruit l'envelope et appelle `queue.send(payload)` sans
   matcher sur `event.type`. Donc une suite qui couvre 3 event types
   (reservation.\*) couvre par construction les 5 (members.\* compris).
2. La dedup consumer est testée séparément (`dedup.test.ts`) avec
   un fake Redis qui exerce le contrat `SET NX EX`. Empiler une
   intégration full mock-CF n'augmenterait pas la confiance.
3. Le contrat producer→outbox est validé par `publish.test.ts` (8
   scénarios incluant rollback transactionnel).

Si une régression survient sur une combinaison spécifique
(event-type-aware bug), elle remontera dans :

- `members.test.ts` (export end-to-end avec publish stub asserté).
- `gateway.integration.test.ts` (chaîne register → book → cancel
  → événements observés sur `state.events`).

## 6. Topology split queues (issue #125)

**État v0.1.1** : trois lanes provisionnées dans `wrangler.toml` :

| Queue                         | Préfixe `event.type`                                                            | Consumer (`worker.ts`)     |
| ----------------------------- | ------------------------------------------------------------------------------- | -------------------------- |
| `athlya-events-notifications` | `reservation.*`, `billing.subscription.failed`, `auth.password_reset.requested` | `handleNotificationsBatch` |
| `athlya-events-rgpd`          | `auth.user.deleted`, `members.export.requested`                                 | `handleRgpdBatch`          |
| `athlya-events` (legacy)      | types non migrés                                                                | `handleEventsBatch`        |

**Routage** : `src/events/route-queue.ts` — publish, outbox drain et DLQ replay utilisent la même table.

**Outbox kick (issue #311)** : `athlya-outbox-kick` (`-staging`, `-preview-pr-<N>`) ne transporte aucun événement. Chaque Worker qui écrit dans `outbox` y envoie un message `outbox.kick` (au plus un par seconde et par isolate). Le gateway le consomme (`max_concurrency = 1`) et lance un drain borné (`runKickDrain`) sans attendre le cron. Voir `docs/runbooks/outbox-ops.md` § Outbox kick.

**Migration** : le topic legacy reste actif pour vider le backlog ; retirer le consumer `athlya-events` une fois `pending=0` sur les types migrés.

### Types inconnus (issue #132)

Les consumers (`handleEventsBatch`, `handleRgpdBatch`, `handleNotificationsBatch`) **n'ack plus silencieusement** un message dont le `event.type` n'est **pas géré par ce consumer / cette lane** (type inconnu globalement ou mal routé, ex. RGPD sur la queue notifications) :

1. Log structuré `queue.unknown_event_type` + métrique `queue_unknown_event_total{ eventType }`
2. Redirect immédiat vers `athlya-events-dlq` via binding `EVENTS_DLQ`, puis `ack` sur la queue primaire
3. Si `EVENTS_DLQ.send` échoue → `msg.retry()` (budget CF puis DLQ automatique)

Alerte Axiom **A15** : voir `docs/operations/axiom-alerts.md`.

**Billing analytics** (`athlya-events-billing`) : hors scope — webhooks Stripe restent HTTP.

### Password-reset emails (issue #645)

`POST /v1/auth/password-reset/request` answers 204 before any account
lookup, then records the request with `auth_request_password_reset`
(migration 0043). A live account gets one `auth.password_reset.requested`
outbox row; an unknown or soft-deleted address gets nothing. The payload
is `{ userId }` only: no email address, no token.

The drain publishes it on `athlya-events-notifications`. The consumer
(`events/password-reset-consumer.ts`) claims `event.id` in the
`notifications:seen:*` dedup keys, mints the token (the previous one is
invalidated) and sends the email through Resend. A failure releases the
claim and retries the message. After `max_retries = 5` it lands on
`athlya-events-notifications-dlq`.

Support and incidents:

- **Nothing in the outbox, queue or DLQ is a credential.** Replaying a DLQ
  message mints a fresh token with a full TTL. An account deleted in the
  meantime is skipped (`outcome: skipped_inactive`).
- **Do not confirm to a requester whether an email was sent or whether the
  account exists.** Ask them to request a new reset. The per-address limit
  is 3 per 24 h.
- **Logs** (`auth.password-reset.delivery`) carry the event id and the
  outcome only. Correlate a support case through the account id in the
  outbox row, never through the address.
- **Deploy order:** the gateway (consumer) must run the #645 code before
  the auth Worker. Otherwise an older consumer quarantines the event on
  `athlya-events-dlq` as an unknown type. Replay it once the gateway is
  updated.

## 7. Liens

- `packages/api/src/events/publish.ts` — protocole publish.
- `packages/api/src/events/drain-worker.ts` — drain pur.
- `packages/api/src/events/drain-scheduled.ts` — adapter cron.
- `packages/api/src/events/drain-dlq.ts` — tracker DLQ.
- `packages/api/src/events/dedup.ts` — dedup consumer.
- `packages/api/src/events/dlq.md` — runbook DLQ détaillé.
- `packages/api/wrangler.toml` § `[triggers]` + `[[queues.consumers]]`.
- `.kiro/specs/athlya-platform/tasks.md` Epic B6 — sous-tâches B6.1
  à B6.4.
