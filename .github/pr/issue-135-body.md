## Contexte

Issue #135 (P2 bug). Le compteur de places vit dans Redis (`class:{id}:remaining`, `DECR`/`INCR` hot-path) tandis que la vérité est PG (`capacity - COUNT(confirmed)`). Un crash Worker entre le `DECR` Redis et le `COMMIT` PG (ou un `INCR` compensatoire manqué) fait diverger les deux → **surbooking** (Redis trop haut) ou **faux complet** (Redis trop bas).

## Changements

- **`packages/reservations/src/reconcile.ts`** (framework-free, ports only) : `reconcileCapacityDrift` parcourt chaque classe active, calcule `expected = max(0, capacity - confirmed)`, compare à Redis :
  - clé absente → **seed** (pas une dérive)
  - `redis !== expected` → log métrique `capacity_redis_pg_drift` (`capacity.drift`, `direction: oversell_risk | false_full`) + **auto-heal** `reset(expected)`
  - isolation par classe (`healFailures`), ne throw jamais sur erreur par-classe
- **`packages/api/src/maintenance/capacity-reconcile-runner.ts`** : runner cron, SQL `LEFT JOIN` confirmed count sur classes actives (`deleted_at IS NULL AND starts_at > now()`), via l'exécuteur `CRON_DB_URL` BYPASSRLS.
- **Wiring `worker.ts` scheduled** : exécuté chaque tick si `CRON_DB_URL` **et** `REDIS_URL`/`REDIS_TOKEN` présents (sinon skip silencieux en dev).
- **Alerte A17** + queries Axiom + `verify-axiom-alerts-checklist` (16 → 17) + **runbook incident** `docs/runbooks/capacity-drift.md` + `verify-capacity-reconcile-checklist.mjs`.
- Tests : 8 (core reconcile) + 2 (runner API).

## Critères d'acceptation

- [x] Job reconcile (testé unitairement ; procédure staging dans le runbook)
- [x] Métrique + alerte (A17)
- [x] Runbook incident drift

## Notes

- **Race transitoire** : un booking entre lecture PG et lecture Redis crée une dérive ±1 qui s'auto-corrige au tick suivant. Seule une dérive **persistante** (alerte A17, ≥ 5 min) est un incident — documenté.
- Auto-heal = `reset(expected)`, eventually-consistent (pas un lock). PG reste autoritatif via `UNIQUE(class_id, user_id)`.

Closes #135
