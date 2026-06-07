## Résumé

Circuit breaker (`packages/api/src/circuit-breaker.ts`) stocke l'état **en mémoire par isolate Cloudflare**. Sous charge, N isolates × probes half-open vers PG/Redis mort → tempête de retries.

Documenté comme accepté (hardening H3) mais risque prod réel.

## Comportement observé

README Limites v0.1 — circuit breaker per-isolate assumé.

Sous panne Neon : chaque isolate vivant (~15s TTL) retente indépendamment.

## Impact

- **Sévérité** : High / P1 resilience
- Amplification incident downstream
- Neon connection storm en plus du booking TCP issue (#3)

## Solution proposée

### Option A — Redis-backed breaker state

Key `cb:{service}:state` avec TTL, partagé cross-isolate.

Coût : +1 Redis RTT (~5ms) — mesurer vs SLO.

### Option B — Cloudflare retry + Hyperdrive fast-fail only

Accepter per-isolate si Hyperdrive (#3) réduit blast radius — **documenter limite**.

### Option C — Breaker au niveau Hyperdrive/Neon pool

Configurer Neon max connections + queue côté pooler.

## Critères d'acceptation

- [ ] Benchmark : breaker Redis vs per-isolate sous panne simulée
- [ ] Décision ADR dans `hardening-plan.md`
- [ ] Test property « open state short-circuits » étendu si Redis

## Priorité

**P1** ou **P2** selon ADR post-Hyperdrive

## Références

- `packages/api/src/circuit-breaker.ts`
- H3 hardening-plan.md
