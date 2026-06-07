## Résumé

TCO documenté README (~80-100€/mois pilote) mais **pas d'alerting coût** runtime. Upstash facture par requête — rate limit + booking DECR + idempotency + sessions = multiplicateur non visible.

## Risques business

- 10 studios actifs → 150-250€/mois (README) sans alerte
- Upstash quota dépassé → fail-open (#6) + facture surprise
- Neon compute scale-up silencieux

## Solution proposée

### 1. Dashboards

| Provider   | Métrique          | Seuil alerte |
| ---------- | ----------------- | ------------ |
| Upstash    | commands/day      | 80% quota    |
| Neon       | compute hours     | plan limit   |
| CF Workers | requests + CPU ms | Paid tier    |
| Resend     | emails/month      | 80% quota    |

### 2. Axiom / BetterStack alerts

Weekly cost review query (manual jusqu'à API billing).

### 3. Doc opérateur

`docs/runbooks/cost-monitoring.md` :

- Formule estimative req/user/jour
- Seuils upgrade plan par composant

### 4. Feature flag kill-switch

Rate limit agressif si Upstash 90% quota (protect bill + platform).

## Critères d'acceptation

- [ ] Runbook cost-monitoring.md
- [ ] Au moins 1 alerte Upstash configurée (doc ops)
- [ ] README TCO lien vers runbook

## Priorité

**P2** — avant 5+ studios actifs
