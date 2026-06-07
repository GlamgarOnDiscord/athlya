## Résumé

API sur Cloudflare Workers. Web Next.js 16 avec TODO `@opennextjs/cloudflare` dans `next.config.ts`. Déploiements **non atomiques**, CORS/cookies cross-origin, surface attaque élargie.

**Finding audit** : A6 — gravité **Medium**, priorité **P2**.

## Comportement observé

- API : wrangler manual
- Web : hébergement non documenté (Vercel ?)
- Pas de runbook deploy unifié

## Solution proposée

### Décision architecture (ADR court)

| Option              | Pros                             | Cons               |
| ------------------- | -------------------------------- | ------------------ |
| OpenNext CF         | Same vendor, cookies first-party | Maturité OpenNext  |
| Vercel web + CF API | DX Next                          | Cross-origin, CORS |
| Monolith Worker     | Simple                           | Refactor lourd     |

1. Rédiger ADR choix explicite
2. Runbook deploy couplé (API + web même pipeline ou ordre fixe)
3. Retirer TODO next.config ou implémenter OpenNext

## Critères d'acceptation

- [ ] ADR publié avec décision
- [ ] Runbook deploy web + API
- [ ] CORS/cookies validés E2E prod
- [ ] TODO next.config résolu

## Références

- `apps/web/next.config.ts`
- Audit prod 2026-05-27 — A6

## Priorité

**P2**
