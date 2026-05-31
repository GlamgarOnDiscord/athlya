## Contexte

Issue #139 (P2 infra, audit A6). API sur CF Workers, web Next.js avec TODO `@opennextjs/cloudflare` non tranché → déploiements non atomiques, CORS/cookies cross-origin, surface élargie.

## Décision — OpenNext → Cloudflare Workers

`docs/security/deploy-web-adr.md` : web sur CF Workers même zone que l'API.

- **Pour** : même vendor (1 pipeline, résidence EU cohérente avec ADR #66), web `app.athlya.app` + API `api.athlya.app` = **domaine enregistrable commun `athlya.app`** → cookies first-party `SameSite=Lax`, CORS minimal.
- **Vercel rejeté** : cross-origin (`SameSite=None`, CORS large, +CSRF), 2e vendor hors résidence EU CF, pipelines non atomiques.
- **Monolith Worker rejeté** : refacto lourd, perte runtime Next.

## Changements

- **`docs/security/deploy-web-adr.md`** : ADR (comparatif, conséquences cookies/CORS, plan d'implémentation, déclencheurs réévaluation).
- **`docs/runbooks/deploy-unified.md`** : runbook ordre déploiement API→web, rollback, checklist CORS/cookies prod.
- **`apps/web/next.config.ts`** : TODO `@opennextjs/cloudflare` **résolu** → référence ADR + plan slice dédiée.
- **`docs/security/README.md`** : lien ADR.

## Critères d'acceptation

- [x] ADR publié avec décision
- [x] Runbook deploy web + API (unifié, ordonné)
- [x] TODO next.config résolu
- [ ] CORS/cookies validés E2E prod : **pendant** l'implémentation de l'adapter (slice dédiée) — checklist fournie dans le runbook

## Note (flag décision)

Décision infra prise en autonomie, justifiée par l'ADR EU residency #66 (CF same-vendor) + bénéfice cookies first-party. **L'implémentation de l'adapter OpenNext est volontairement hors PR** : elle modifie l'infra de déploiement et exige une validation build/deploy réelle, bloquée par le quota CI billing (#123). Si tu préfères Vercel malgré le cross-origin, dis-le et je réoriente l'ADR.

Closes #139
