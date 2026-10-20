# Réservations concurrentes : garanties et limites

Issues #713 (phase A, code seul) et #723 (phase B, migration 0050). But :
aucune surréservation, aucun doublon, aucune réponse fausse, même quand des
centaines de membres réservent la même séance à la même seconde ou rejouent
leurs requêtes.

## Garanties et où elles sont tenues

| Garantie                                                      | Où                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmés + holds actifs <= capacité` à tout commit          | Trigger `enforce_class_capacity()` (0008, réécrit en 0050) : verrou `FOR UPDATE` sur la ligne `classes` puis comptage, avant chaque confirmé ou hold |
| Une seule ligne vivante par membre et séance                  | Index uniques partiels : `confirmed`/`waitlist` (0028), `NOT IN ('cancelled','no_show')` qui couvre aussi `pending` (0050)                           |
| Une requête rejouée n'agit qu'une fois                        | Middleware idempotence en mode strict : verrou en vol Redis, hash de la requête, fail closed (réservation, hold, confirmation, annulation)           |
| Le rejeu dit la vérité                                        | 409 avec le vrai statut (`confirmed` ou `waitlist`) et la position ; DELETE rejoué : 200 `alreadyCancelled: true` ; confirmation rejouée : 200       |
| Pas de 5xx sur un conflit transitoire                         | Rejeu de la transaction entière, 3 essais, backoff aléatoire, uniquement sur 40001 et 40P01                                                          |
| Liste d'attente FIFO                                          | `created_at` puis `id`, `FOR UPDATE SKIP LOCKED`, à l'annulation, à la libération d'un hold, à la hausse de capacité et par le cron                  |
| Capacité jamais sous les places prises                        | Service sous verrou (409 `capacity_below_confirmed`), puis trigger `guard_class_schedule()` pour tout écrivain                                       |
| Horaire figé une fois la séance commencée                     | Service (409 `class_already_started`, 422 `starts_at_in_past`), puis `guard_class_schedule()`                                                        |
| `version` avance à chaque changement de capacité ou d'horaire | `guard_class_schedule()` refuse sinon (`class_version_not_bumped`), y compris en SQL direct                                                          |
| Le temps fait foi côté base                                   | `class_in_past`, la fenêtre de 2 h, l'expiration des holds et le guard lisent `now()` dans la transaction                                            |

Redis (`class:{id}:remaining`) n'est qu'un préfiltre optimiste. Faux
dans un sens ou dans l'autre, il envoie un membre vers la mauvaise
branche, jamais au-delà de la capacité.

## Holds de place (0050)

- `POST /v1/reservations/holds` crée une ligne `pending` avec
  `hold_expires_at = now() + 10 min` (`DEFAULT_HOLD_TTL_SECONDS`, plafond
  30 min imposé par le trigger). Classe pleine : 409 `class_full`, rien
  n'est écrit (pas de liste d'attente pour un hold).
- Un hold actif compte comme une place prise ; il cesse de compter à
  l'instant où il expire, sans attendre le balayage. Il ne peut être ni
  prolongé ni rouvert.
- `POST /v1/reservations/{id}/confirm` le passe en `confirmed` avec
  l'événement `reservation.created`. La place est déjà comptée : aucune
  course à la capacité. Hold expiré : 409 `hold_expired`.
- `DELETE /v1/reservations/{id}` libère un hold (sans fenêtre de 2 h ni
  événement `reservation.cancelled`) ; sa place va au plus ancien en
  attente ou au compteur.
- Une réservation classique sur un hold actif du même membre le confirme ;
  sur un hold expiré, elle le libère et réserve.
- Compatibilité : aucune réponse existante ne change de forme. La ligne
  de réservation n'expose pas `hold_expires_at` (absente du schéma
  Drizzle, le `ReservationSchema` strict est déjà dans l'app mobile) et
  `GET /v1/reservations/me` exclut les holds.

## Fencing par version

`classVersion` (optionnel) dans `POST /v1/reservations` et
`POST /v1/reservations/holds` : la version de la séance que le membre a
vue. Vérifiée avant Redis, puis sous le verrou de la ligne `classes`
(`reservation_lock_class_for_booking`) : 409 `class_changed` si la séance
a été modifiée entre-temps. Sans `classVersion`, rien ne change. Côté
admin, le PATCH porte déjà `version` (409 `version_conflict`) et le
trigger oblige toute autre écriture à faire avancer `version`.

## Cron : expiration et promotion

Chaque tick, avant la réconciliation Redis, `athlya_cron` appelle
`reservation_sweep_holds_and_promote(200)` : holds échus annulés, plus
anciens en attente promus dans les places libres des séances à venir,
un `reservation.promoted` chacun. Une séance dont la ligne est verrouillée
par une réservation est sautée (`SKIP LOCKED`) et reprise au tick suivant.
La réconciliation qui suit remet le compteur Redis d'aplomb, y compris la
place rendue par un hold expiré.

## Modes de défaillance

- **Redis en panne** : réservation et hold refusés en 503
  `counter_unavailable`, routes idempotentes en 503
  `idempotency_unavailable`. Rien n'est écrit.
- **Compensation `INCR` perdue, hold expiré** : compteur trop bas (faux
  "complet") jusqu'au cron, qui corrige par un compare-and-set Lua.
- **Store d'idempotence en panne après la mutation** : la réponse réelle
  part, l'erreur est journalisée ; un nouvel essai tombe sur l'index
  unique, `already_cancelled` ou `already_confirmed`.
- **Worker qui meurt pendant une requête** : le verrou en vol expire
  après 30 s ; un hold orphelin expire seul.
- **Balayage en échec** (migration absente) : journalisé, la
  réconciliation Redis tourne quand même.

## Limites connues

1. Hash de requête dans une colonne dédiée (`request_hash`) : toujours
   dans le JSON stocké, reporté pour ne pas élargir la phase B.
2. Contract à faire : supprimer l'index 0028, redondant avec celui de 0050. La valeur d'enum `pending` ne peut pas être retirée.
3. Aucun client n'utilise encore les holds ni `classVersion`.

Mise en service : [`docs/runbooks/booking-holds-rollout.md`](../runbooks/booking-holds-rollout.md).

## Tests

- `packages/db/tests/rls/booking_holds_fencing.sql` : triggers, holds,
  fencing, balayage, grants et propriétaires (pgTAP).
- `packages/api/tests/integration/booking-concurrency.docker.test.ts` :
  vraie concurrence sur Postgres 17, toutes les migrations, rôle
  `athlya_app` (NOBYPASSRLS), dont N holds concurrents sur C places.
- `packages/reservations/tests/properties/booking.property.test.ts` :
  propriété de capacité, toutes les migrations, même rôle.
- `packages/api/src/__tests__/adapters/reservations-booking.pglite.test.ts` :
  SQL et politiques des adaptateurs, sans Docker.
- `scripts/verify-role-contract.mjs` : hold et balayage sous les vrais rôles.
