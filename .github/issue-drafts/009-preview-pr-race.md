## Résumé

L'environnement preview (`wrangler.toml` `[env.preview]`) réutilise **un seul Worker** `athlya-api-preview`. Le secret `DB_URL` est écrasé à chaque deploy PR → **race condition** si 2 PRs deploy simultanément.

## Comportement observé

Commentaire wrangler.toml L404-405 :

> Concurrency note: simultaneous PR deployments race on the DB_URL secret.

Preview partage aussi Redis/Queues/R2 staging → contamination possible.

## Impact

- **Sévérité** : High / P1 (si previews utilisées)
- PR A testée contre DB PR B
- Faux positifs/négatifs QA
- Risque fuite données seed entre PRs

## Solution proposée

### Option A — Worker par PR (recommandée)

```yaml
# preview.yml
wrangler deploy --env preview --name "athlya-api-pr-${{ github.event.pull_request.number }}"
```

Nécessite route dynamique ou workers.dev URL par PR (déjà partiellement fait).

### Option B — Mutex deploy

Concurrency group global preview + queue (ralentit l'équipe).

### Option C — Désactiver preview partagé

Documenter previews local-only jusqu'à Workers for Platforms.

## Critères d'acceptation

- [ ] Deux PRs concurrentes → DB_URL isolées
- [ ] Commentaire race supprimé de wrangler.toml
- [ ] `docs/runbooks/preview-pr.md` mis à jour

## Priorité

**P1** si previews actives, **P2** sinon
