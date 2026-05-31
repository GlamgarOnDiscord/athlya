## Contexte

Audit prod R1 (Medium/P2, issue #140) : le circuit breaker est **per-isolate**. Sous panne downstream prolongée, les N isolates ayant tripé au même instant promeuvent `open → half_open` au **même** `openedAt + resetTimeoutMs` → pic de probes synchronisés (connection storm) contre un service encore mort.

Décision ADR #73 (état per-isolate, pas de Redis-backed) **maintenue** — coordination globale = +5–10 ms RTT sur le hot path, non justifiable face au budget p99 < 500 ms.

## Changements

- **Jitter half-open per-isolate** (anti-storm, zéro coût hot path, zéro état partagé) :
  - `resetJitterMs` (défaut 20 % de `resetTimeoutMs`) ajouté au deadline de promotion.
  - Jitter tiré frais à **chaque trip**, clampé `[0, resetJitterMs)`.
  - `random` injectable → tests déterministes.
- **Hook `onTransition`** optionnel : émet `{name, from, to, at, jitterMs}` à chaque changement d'état → métrique transitions câblable au call site. Best-effort (exceptions avalées, jamais d'escalade en 500). Le breaker reste framework-free.
- ADR `docs/security/circuit-breaker-adr.md` ré-évalué post-audit R1 (décision, garde-fous, critères d'acceptation).

## Invariants préservés

- 1 probe/isolate/fenêtre (déjà garanti par `probeInFlight`) — le jitter étale les probes dans le temps, ne change pas le plafond.
- Comportement exact-deadline conservé via `resetJitterMs: 0`.

## Tests

- `half-open jitter` : deadline décalée, deux isolates même instant → probes désynchronisés, jitter frais par trip, `resetJitterMs < 0` rejeté.
- `onTransition hook` : séquence `closed→open→half_open→closed` émise avec `jitterMs`, exceptions du hook avalées.
- `npx vitest run src/__tests__/circuit-breaker.test.ts` → 21/21. `tsc --noEmit` clean.

Closes #140
