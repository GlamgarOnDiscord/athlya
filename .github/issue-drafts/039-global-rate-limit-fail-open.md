## Résumé

Rate limit **mutations** = fail-closed (issue #65 ✅). Rate limit **global IP** = **fail-open** si Redis down (`worker.ts:591`).

**Finding audit** : C6 / S4 — gravité **High**, priorité **P1**.

## Code concerné

```typescript
// worker.ts ~591
guardLimiterWithDevBypass('global', ipLimiter, 'fail-open');
```

Commentaire L558 : "global IP limiter stays fail-open so read traffic..."

## Impact production

Redis Upstash down / quota :

- Reads illimités → scraping, charge Neon/Workers
- Coût CF + Neon **explose**
- DoS applicatif partiel même si mutations protégées
- Attaquant cible endpoints read-heavy

## Solution proposée

### Option A — Fail-closed soft global

Si Redis unhealthy : 429 sur toutes routes sauf `/health`, `/health/ready`

### Option B — Cloudflare WAF rate rules backup

Rate limit edge indépendant Redis (100 req/min/IP)

### Option C — Hybrid

Reads : fail-open avec cap hardcoded in-memory per-isolate (faible mais mieux que rien)

### Monitoring

Métrique `rate_limit_fail_open_total` + alerte Axiom

## Critères d'acceptation

- [ ] Comportement Redis down documenté et testé
- [ ] Coût runaway limité (WAF ou fail-closed)
- [ ] Pas de régression UX reads normales
- [ ] Test chaos Redis down staging

## Références

- `packages/api/src/worker.ts` L558-591
- `packages/api/src/middleware/limiter-guard.ts`
- Issue fermée #65 (mutations only)
- Audit prod 2026-05-27 — C6, S4

## Priorité

**P1** — résilience + coût sous incident Redis
