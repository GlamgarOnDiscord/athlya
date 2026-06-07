## Résumé

Circuit breaker **in-memory per-isolate** (`circuit-breaker-adr.md`). Sous panne Neon/Redis : **N isolates** continuent half-open probes → tempête retries.

**Finding audit** : R1 — gravité **Medium**, priorité **P2**.

Issue #73 fermée (ADR Redis-backed rejeté) — **revoir post-incident** ou implémenter version légère.

## Impact

Incident downstream prolongé, cascade 503 partielle, amplification charge Neon.

## Solution proposée

### Option A — Redis-backed breaker global

État partagé Upstash : `breaker:neon:state`

### Option B — CF Workers for Platforms / Durable Object breaker

Single coordinator

### Option C — Edge rate limit downstream calls

Cap global appels PG/min via DO

Requantifier tradeoff "Redis trop lent" vs coût incident.

## Critères d'acceptation

- [ ] ADR mis à jour avec décision post-audit
- [ ] Si implémenté : test panne Neon → 1 probe/isolate max
- [ ] Métrique breaker state transitions

## Références

- `docs/runbooks/circuit-breaker-adr.md`
- Issue fermée #73
- Audit prod 2026-05-27 — R1

## Priorité

**P2**
