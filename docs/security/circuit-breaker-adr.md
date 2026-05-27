# ADR — Circuit breaker per-isolate (issue #73 / H3)

**Statut** : accepté  
**Date** : 2026-05-27  
**Issue** : #73

## Contexte

Sous panne Neon/Redis, chaque isolate Cloudflare Worker (~15 s TTL idle) maintient son propre `CircuitBreaker` en mémoire. Jusqu'à N isolates peuvent envoyer un probe half-open par cycle → risque d'amplification (connection storm).

## Décision

**Option B (issue #73)** : conserver l'état **per-isolate** documenté comme fuse local best-effort. **Rejeter Option A** (état Redis `cb:{service}:state`).

| Critère | Per-isolate (retenu) | Redis-backed (rejeté) |
|---------|----------------------|------------------------|
| Latence hot path | 0 ms additionnel | +5–10 ms RTT Redis estimé |
| Coordination globale | Non (N probes max) | Oui |
| SLO p99 réservation (< 500 ms) | Compatible | Risque budget dépassé |
| Implémentation | Livré (`circuit-breaker.ts`) | Nouveau port + ops Redis |

## Benchmark (design review, pas load test formel)

Hypothèse : breaker check sur **chaque** appel downstream Redis/Postgres (~2–4 appels / requête booking).

- Redis state read/write : ~1–2 RTT × 5 ms ≈ **5–10 ms** par requête.
- Sur p99 cible 500 ms, +10 ms = **+2 %** du budget en nominal, plus en cascade si le breaker bloque tard.

Conclusion : le coût latence outweigh le bénéfice coordination tant que Hyperdrive fail-fast + Upstash SLA limitent déjà le blast radius (issue #62, commentaire H3 dans `circuit-breaker.ts`).

## Garde-fous code

- Property test : `fn` jamais appelé quand `state() === 'open'`.
- Test `isolate independence (H3 invariant)` : deux breakers même `name` indépendants.
- JSDoc bloc « Semantics under Cloudflare Workers » dans `packages/api/src/circuit-breaker.ts`.

## Escape hatch

Dépendances à coût d'échec élevé (ex. PSP) peuvent wrapper un **second** breaker Redis au call site — hors défaut plateforme.

## Références

- `.kiro/specs/athlya-platform/hardening-plan.md` § H3
- `packages/api/src/__tests__/circuit-breaker.test.ts`
