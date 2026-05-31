# Runbook — Capacity drift Redis↔PG (issue #135)

## Contexte

Le compteur de places `class:{id}:remaining` (Upstash Redis) est le hot-path du booking (`packages/reservations/src/book.ts`, Algorithm 1). PostgreSQL est **la source de vérité** : `capacity - COUNT(confirmed)`. Un crash Worker entre le `DECR` Redis et le `COMMIT` PG, ou un `INCR` compensatoire manqué, fait diverger les deux :

| Sens | Symptôme | Risque |
|------|----------|--------|
| Redis **> ** attendu | `direction: oversell_risk` | surbooking (places vendues que PG ne couvre pas) |
| Redis **< ** attendu | `direction: false_full` | faux « complet », users poussés en waitlist à tort |

## Réconciliation automatique

- Cron Worker (`worker.scheduled`) → `runScheduledCapacityReconcile` chaque tick (1 min), si `CRON_DB_URL` (BYPASSRLS) **et** `REDIS_URL`/`REDIS_TOKEN` présents.
- Pour chaque classe **active** (non soft-deleted, `starts_at > now()`) :
  - `expected = max(0, capacity - confirmed)`
  - clé Redis absente → **seed** (pas une dérive)
  - `redis !== expected` → log `capacity.drift` (`metric: capacity_redis_pg_drift`) + **auto-heal** `reset(expected)`
- Isolation par classe : un échec Redis/PG sur une classe ne stoppe pas la passe (`healFailures`).

### Race transitoire (attendu, bénin)

Un booking qui tombe entre la lecture PG et la lecture Redis crée une dérive ±1 qui s'auto-corrige à la passe suivante. **Seule une dérive persistante (≥ 5 min, alerte A17) est un incident.**

## Alerte

- **A17** (`docs/operations/axiom-alerts.md`) : drift persistant 2 sweeps consécutifs ou `oversell_risk` à drift élevé → Slack `#ops-athlya-alerts`.
- Queries : `docs/operations/axiom-queries.md` § Capacity drift.

## Incident — dérive persistante

1. Confirmer dans Axiom : `capacity.drift` répété sur le **même** `classId` sur plusieurs sweeps (≠ ±1 transitoire).
2. Vérifier crash Worker / déploiement récent (`book.ts` compensation `INCR`).
3. Vérifier santé Upstash (latence, éviction de clés).
4. Si auto-heal ne tient pas (heal puis re-drift immédiat) → bug actif de double-DECR ou INCR manquant : **désactiver le booking de la classe** ou réduire capacité le temps du fix.
5. Reset manuel forcé d'une classe (depuis la vérité PG) :

```sql
-- valeur attendue
SELECT c.capacity - COALESCE(COUNT(r.*) FILTER (WHERE r.status='confirmed'),0) AS expected
  FROM classes c LEFT JOIN reservations r ON r.class_id=c.id
 WHERE c.id = '<classId>' GROUP BY c.capacity;
```

```bash
# puis écraser la clé Redis (Upstash REST)
curl -s -X POST "$REDIS_URL/set/class:<classId>:remaining/<expected>" \
  -H "Authorization: Bearer $REDIS_TOKEN"
```

## Test charge (staging)

1. Brancher Neon staging + Upstash staging.
2. Injecter une dérive : `DECR` Redis sans réservation PG (simuler crash post-DECR).
3. Attendre 1 tick cron → vérifier log `capacity.drift` puis `reset`, Redis = `expected`.
4. Vérifier `sweep complete` : `drifted ≥ 1`, `healed ≥ 1`, `healFailures = 0`.

## Références

- `packages/reservations/src/reconcile.ts` — sweep framework-free
- `packages/api/src/maintenance/capacity-reconcile-runner.ts` — runner + SQL
- `packages/reservations/src/book.ts` — protocole DECR/INCR
- `scripts/verify-capacity-reconcile-checklist.mjs`
