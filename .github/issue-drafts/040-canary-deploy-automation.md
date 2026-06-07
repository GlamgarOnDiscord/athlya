## Résumé

`wrangler deploy` bascule **100% trafic instantanément**. Runbook `canary-deploy.md` (#80) documente procédure manuelle — **pas automatisé**.

**Finding audit** : R2 — gravité **High**, priorité **P1**.

## Comportement attendu

- Deploy staging → smoke → canary 5% → 25% → 100%
- Rollback automatique si error rate spike
- Workers Versions API ou traffic splitting CF

## Comportement observé

Deploy prod = commande manuelle opérateur. Erreur regression = **100% users impactés**.

## Solution proposée

### Phase 1 — Workers Versions (si plan supporté)

```bash
wrangler versions upload
wrangler versions deploy --percentage 5
# monitor 10min
wrangler versions deploy --percentage 100
```

### Phase 2 — GitHub Actions

Workflow `deploy-production.yml` :

1. Deploy staging
2. `./scripts/wait-health-ready.sh staging`
3. Canary prod 5%
4. Gate : Axiom error rate < seuil
5. Promote 100%

### Phase 3 — Rollback

Documenter `wrangler rollback` + critères auto

## Critères d'acceptation

- [ ] Au moins 1 canary deploy réussi staging→prod
- [ ] Rollback testé < 5 min
- [ ] Runbook canary lié au workflow
- [ ] Pas de deploy prod sans smoke ready

## Références

- `docs/runbooks/canary-deploy.md`
- Issue fermée #80 (runbook only)
- Audit prod 2026-05-27 — R2

## Priorité

**P1** — avant trafic studio réel
