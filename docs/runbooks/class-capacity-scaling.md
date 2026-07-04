# Runbook — ClassCapacityDO scaling (issue #141 / audit P6)

## Modèle

- `ClassCapacityDO` : **1 instance par cours** (`idFromName(classId)`), WebSocket hibernatable pour pousser `{ type: 'capacity_update', classId, remaining }` en temps réel.
- Endpoint public : `GET /v1/classes/:classId/capacity/ws` (upgrade WebSocket, pas d'auth — `remaining` est déjà public sur `GET /v1/classes`).

## Limite documentée

Un DO est **mono-thread, un seul isolate**. Un _hot class_ (cours très demandé) concentre **tous** les abonnés sur cette instance :

- broadcast = **O(abonnés)** à chaque booking/cancel ;
- mémoire connexions bornée par le DO.

**Cap** : `CLASS_CAPACITY_MAX_WS` (défaut **500**, cf. `DEFAULT_CLASS_CAPACITY_MAX_WS` dans `durable-objects/class-capacity.ts`). Au-delà, le DO **shed** les nouveaux upgrades.

## Fallback (DO saturé)

Quand `getWebSockets().length >= cap`, l'upgrade renvoie :

```
HTTP/1.1 503 Service Unavailable
X-Capacity-Fallback: poll
Retry-After: 30
{ "error": "capacity_do_saturated" }
```

**Contrat client** : sur `503` + `X-Capacity-Fallback: poll`, ne pas retenter en boucle sur le WS — basculer en **polling** `GET /v1/classes` (le listing porte déjà `remaining`) à un intervalle ≥ `Retry-After`. Le client web actuel rend `remaining` de façon statique (SSR) ; le WS est opt-in, donc ce contrat s'applique à tout futur consommateur WS.

## Tuning

- Augmenter `CLASS_CAPACITY_MAX_WS` (var Worker, string) si benchmark staging montre de la marge CPU/mémoire DO.
- Valeur invalide / non-positive / absente → retombe sur le défaut 500 (parse défensif).

## Sharding (si le cap par cours devient insuffisant)

Options non implémentées (à activer sur données d'incident) :

1. **Sharding DO par tranche** : `idFromName("<classId>:<shard>")` avec N shards, fan-out croisé par broadcast inter-shard ou via le drain outbox.
2. **SSE agrégé studio-wide** : un flux par studio plutôt qu'un WS par cours, en lecture seule.
3. Polling pur si le temps réel n'est pas critique pour le tier concerné.

## Cap rationale — CLASS_CAPACITY_MAX_WS = 500 (issue #423)

The 500-connection default was chosen based on the following bounds:

| Constraint                | Bound                        | Source                              |
| ------------------------- | ---------------------------- | ----------------------------------- |
| DO max WebSocket count    | ~1 000 (CF undocumented)     | Community reports + hibernation API |
| broadcast O(n) at 500     | ~5–50 ms per update (est.)   | Depends on DO CPU slice scheduling  |
| Memory per WS connection  | ~10 KB                       | CF isolate overhead                 |
| Memory at 500 connections | ~5 MB (well under 128 MB DO) | —                                   |
| Realistic hot-class peak  | < 50 concurrent watchers     | UX: most users don't keep WS open   |

**500 is deliberately conservative.** It was not measured against a live CF
environment — see the benchmark script (`k6/do-fanout.js`) to obtain actual
p95 broadcast latency numbers before raising the cap.

**Product launch guidance**: a class with > 500 simultaneous open WebSocket
connections is extremely unlikely at current scale. The shed + poll fallback
protects availability. Monitor `do_connections_failed` and `do_shed_rate`
(emitted by the benchmark) via Axiom when real traffic is flowing.

## Running the benchmark (issue #423)

```bash
# Requires a staging class ID with at least 1 confirmed booking.
K6_BASE_URL=https://staging.api.athlya.app \
K6_CLASS_ID=<uuid> \
K6_WS_CAP=500 \
K6_BOOKING_TOKEN=<bearer-token> \
k6 run k6/do-fanout.js
```

**Acceptance criteria (from the benchmark report):**

- p95 broadcast latency < 500 ms at cap connections
- Shed rate ≥ 80 % for the `above_cap` scenario
- Connection failures < 10

If p95 latency is well under 100 ms at cap=500, raise `CLASS_CAPACITY_MAX_WS`
to 750 or 1 000 and re-run. If p95 > 500 ms, reduce the cap or consider
sharding (see below).

## Related

- `packages/api/src/durable-objects/class-capacity.ts` — cap + shed
- `packages/api/src/routes/capacity.ts` — proxy upgrade (forward le 503)
- `packages/api/src/__tests__/durable-objects/class-capacity.test.ts` — tests cap/fallback
- `k6/do-fanout.js` — WebSocket fanout benchmark script
