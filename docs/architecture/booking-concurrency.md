# Réservations concurrentes : garanties et limites

Issue #713 (phase A, code seul). But : aucune surréservation, aucun
doublon, aucune réponse fausse, même quand des centaines de membres
réservent la même séance à la même seconde ou rejouent leurs requêtes.

## Garanties et où elles sont tenues

| Garantie                                       | Où                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `confirmés <= capacité` à tout instant commité | Trigger `enforce_class_capacity()` (0008) : verrou `FOR UPDATE` sur la ligne `classes` puis comptage, avant chaque confirmation |
| Une seule ligne vivante par membre et séance   | Index unique partiel `(class_id, user_id) WHERE status IN ('confirmed','waitlist')` (0028)                                      |
| Une requête rejouée n'agit qu'une fois         | Middleware idempotence en mode strict : verrou en vol Redis, hash de la requête, fail closed                                    |
| Le rejeu dit la vérité                         | 409 avec le vrai statut (`confirmed` ou `waitlist`) et la position ; DELETE rejoué : 200 `alreadyCancelled: true`               |
| Pas de 5xx sur un conflit transitoire          | Rejeu de la transaction entière, 3 essais, backoff aléatoire, uniquement sur 40001 et 40P01                                     |
| Liste d'attente FIFO                           | `created_at` puis `id`, `FOR UPDATE SKIP LOCKED`, à l'annulation et à la hausse de capacité                                     |
| Capacité jamais sous les confirmés             | `updateClassOptimistic` sous verrou de la ligne `classes` : 409 `capacity_below_confirmed`                                      |
| Le temps fait foi côté base                    | `class_in_past` et la fenêtre de 2 h lisent `now()` dans la transaction ; l'horloge injectée reste pour les tests               |

Redis (`class:{id}:remaining`) n'est qu'un préfiltre optimiste. Faux
dans un sens ou dans l'autre, il envoie un membre vers la mauvaise
branche, jamais au-delà de la capacité.

## Modes de défaillance

- **Redis en panne** : réservation refusée en 503 `counter_unavailable`,
  routes idempotentes en 503 `idempotency_unavailable`. Rien n'est écrit.
- **Compensation `INCR` perdue** : journalisée, compteur trop bas
  (faux "complet") jusqu'au cron de réconciliation, qui corrige par un
  compare-and-set Lua : il n'écrase jamais un `DECR` arrivé entre sa
  lecture et son écriture.
- **Store d'idempotence en panne après la mutation** : la réponse réelle
  part, l'erreur est journalisée ; un nouvel essai tombe sur l'index
  unique ou sur `already_cancelled`.
- **Worker qui meurt pendant une requête** : le verrou en vol expire
  après 30 s.

## Limites connues (phase B)

Phase B demande une migration, donc l'accord de Tom ou Pierre.

1. Statut `pending` et holds avec TTL : réserver un siège le temps d'un
   paiement ou d'une confirmation, libéré automatiquement.
2. Trigger qui protège `capacity` et `starts_at` contre toute écriture
   hors du chemin applicatif (SQL direct, outil d'admin).
3. Fencing par `classes.version` : chaque réservation lit la version et
   échoue si la séance a changé entre-temps.
4. Promotion de la liste d'attente par le cron de réconciliation :
   `athlya_cron` n'a aujourd'hui ni accès aux réservations ni droit sur
   `reservation_promote_oldest_waitlist`. En attendant, la promotion se
   fait à l'annulation et à la hausse de capacité.
5. Hash de requête dans une colonne dédiée (`request_hash`) plutôt que
   dans le JSON stocké.

## Tests

- `packages/api/tests/integration/booking-concurrency.docker.test.ts` :
  vraie concurrence sur Postgres 17, toutes les migrations, rôle
  `athlya_app` (NOBYPASSRLS).
- `packages/reservations/tests/properties/booking.property.test.ts` :
  propriété de capacité, toutes les migrations, même rôle.
- `packages/api/src/__tests__/adapters/reservations-booking.pglite.test.ts` :
  SQL et politiques des adaptateurs, sans Docker.
