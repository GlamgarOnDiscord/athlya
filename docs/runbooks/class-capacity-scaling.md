# Runbook — ClassCapacityDO scaling (issue #141 / audit P6)

## Modèle

- `ClassCapacityDO` : **1 instance par cours** (`idFromName(classId)`), WebSocket hibernatable pour pousser `{ type: 'capacity_update', classId, remaining }` en temps réel.
- Endpoint public : `GET /v1/classes/:classId/capacity/ws` (upgrade WebSocket, pas d'auth — `remaining` est déjà public sur `GET /v1/classes`).

## Limite documentée

Un DO est **mono-thread, un seul isolate**. Un *hot class* (cours très demandé) concentre **tous** les abonnés sur cette instance :

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

## Load test (staging — critère d'acceptation)

1. Ouvrir N connexions WS simultanées vers `…/capacity/ws` d'un même `classId` (N > cap).
2. Vérifier : les `cap` premières reçoivent les `capacity_update`, les suivantes reçoivent `503 + X-Capacity-Fallback: poll`.
3. Mesurer latence broadcast p95 à `cap` connexions sous charge de booking → valider/ajuster `CLASS_CAPACITY_MAX_WS`.

## Related

- `packages/api/src/durable-objects/class-capacity.ts` — cap + shed
- `packages/api/src/routes/capacity.ts` — proxy upgrade (forward le 503)
- `packages/api/src/__tests__/durable-objects/class-capacity.test.ts` — tests cap/fallback
