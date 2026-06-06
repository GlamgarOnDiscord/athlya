# ADR — Circuit breaker per-isolate (issue #73 / H3, ré-évalué #140 / R1)

**Statut** : accepté (ré-évalué post-audit R1)  
**Date** : 2026-05-27 (révisé 2026-05-31)  
**Issue** : #73, ré-évaluation #140

## Contexte

Sous panne Neon/Redis, chaque isolate Cloudflare Worker (~15 s TTL idle) maintient son propre `CircuitBreaker` en mémoire. Jusqu'à N isolates peuvent envoyer un probe half-open par cycle → risque d'amplification (connection storm).

L'audit prod 2026-05-27 a rouvert le sujet (**R1, Medium/P2**) : sous panne prolongée, les N isolates ayant tripé au même instant promeuvent leur breaker `open → half_open` au **même** `openedAt + resetTimeoutMs` → pic de probes synchronisés contre un downstream encore mort.

## Décision

**Option B (issue #73) maintenue** : état **per-isolate**, fuse local best-effort. **Option A rejetée** (état Redis `cb:{service}:state`) — voir benchmark latence inchangé.

**Mitigation R1 ajoutée (#140)** : **jitter per-isolate** sur la promotion half-open, **sans état partagé ni coût hot path**.

- `resetJitterMs` (défaut **20 % de `resetTimeoutMs`**, soit 12 s) ajouté au deadline : chaque trip tire `jitter ∈ [0, resetJitterMs)` via `random()`. Les N isolates probent désormais étalés sur `[reset, reset + jitter)` au lieu de tous à `reset`.
- Jitter **retiré à chaque trip** (fenêtre de panne indépendante).
- `random` injectable → tests déterministes.
- Hook `onTransition` optionnel → émission **métrique transitions d'état** au call site (le breaker reste framework-free ; exceptions du hook avalées pour ne jamais escalader une panne en 500).

Pourquoi pas Option A/B(DO)/C maintenant : le jitter résout le pic synchronisé (cœur de R1) à coût nul. Le plafond reste **1 probe/isolate/fenêtre** (inchangé, déjà garanti par `probeInFlight`) — la coordination globale (Redis/DO) n'apporterait qu'une réduction du nombre total de probes, pas justifiable face au budget latence p99 < 500 ms tant que Hyperdrive fail-fast + Upstash SLA bornent le blast radius.

| Critère                        | Per-isolate (retenu)         | Redis-backed (rejeté)     |
| ------------------------------ | ---------------------------- | ------------------------- |
| Latence hot path               | 0 ms additionnel             | +5–10 ms RTT Redis estimé |
| Coordination globale           | Non (N probes max)           | Oui                       |
| SLO p99 réservation (< 500 ms) | Compatible                   | Risque budget dépassé     |
| Implémentation                 | Livré (`circuit-breaker.ts`) | Nouveau port + ops Redis  |

## Benchmark (design review, pas load test formel)

Hypothèse : breaker check sur **chaque** appel downstream Redis/Postgres (~2–4 appels / requête booking).

- Redis state read/write : ~1–2 RTT × 5 ms ≈ **5–10 ms** par requête.
- Sur p99 cible 500 ms, +10 ms = **+2 %** du budget en nominal, plus en cascade si le breaker bloque tard.

Conclusion : le coût latence outweigh le bénéfice coordination tant que Hyperdrive fail-fast + Upstash SLA limitent déjà le blast radius (issue #62, commentaire H3 dans `circuit-breaker.ts`).

## Garde-fous code

- Property test : `fn` jamais appelé quand `state() === 'open'`.
- Test `isolate independence (H3 invariant)` : deux breakers même `name` indépendants.
- Tests `half-open jitter` (#140) : deadline décalée du jitter, deux isolates même instant de trip → probes désynchronisés, jitter frais par trip, `resetJitterMs < 0` rejeté.
- Tests `onTransition hook` (#140) : séquence `closed→open→half_open→closed` émise avec `jitterMs`, exceptions du hook avalées.
- JSDoc bloc « Semantics under Cloudflare Workers » (point d, jitter) dans `packages/api/src/circuit-breaker.ts`.

## Escape hatch

Dépendances à coût d'échec élevé (ex. PSP) peuvent wrapper un **second** breaker Redis au call site — hors défaut plateforme. Si un incident futur montre que le jitter ne suffit pas (downstream saturé même à probe étalé), réévaluer Option A/C avec données d'incident à l'appui.

## Critères d'acceptation R1 (#140)

- [x] ADR mis à jour avec décision post-audit (ce document).
- [x] Mitigation implémentée : 1 probe/isolate/fenêtre conservé + probes désynchronisés par jitter (tests `half-open jitter`).
- [x] Hook métrique transitions d'état (`onTransition`) câblable au call site.

## Références

- `.kiro/specs/athlya-platform/hardening-plan.md` § H3
- `.github/issue-drafts/051-circuit-breaker-redis-revisit.md` (finding R1)
- `packages/api/src/__tests__/circuit-breaker.test.ts`
