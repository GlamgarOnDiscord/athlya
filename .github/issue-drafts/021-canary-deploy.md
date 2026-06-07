## Résumé

`wrangler deploy --env production` bascule **100% du trafic** instantanément. Pas de canary, pas de versions API traffic split. `.kiro/specs/athlya-platform/critique.md` C2.x — risque regression masse.

## Solution proposée

### Cloudflare Workers Versions

```bash
# Upload version
wrangler versions upload --env production

# Gradual traffic (API Cloudflare)
curl -X PATCH .../traffic-split { "percentages": { "version-a": 90, "version-b": 10 } }
```

### CI pipeline

1. Deploy version N+1 → 5% traffic 15 min
2. Monitor Sentry error rate + Axiom p99
3. Auto rollback si error rate > 2× baseline
4. Promote 100% ou rollback

### Script

`scripts/canary-deploy.mjs` + doc `docs/runbooks/canary-deploy.md`

## Critères d'acceptation

- [ ] Runbook canary documenté
- [ ] Au moins 1 canary testé staging
- [ ] Rollback < 5 min documenté

## Priorité

**P2** — avant premier deploy prod avec users payants

## Références

- Cloudflare Workers gradual deployments docs
- critique.md — pas de canary deploy
