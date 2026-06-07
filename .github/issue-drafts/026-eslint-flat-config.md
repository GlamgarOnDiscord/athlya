## Résumé

`apps/web` utilise dual ESLint config : `.eslintrc.json` (legacy) + root flat config `eslint.config.js`. Documenté `docs/ACTION-ITEMS.md` C3 — confusion règles actives.

## Impact

- **Sévérité** : Low / P3
- Règles lint incohérentes web vs packages
- Blocker migration ESLint 10 (EOL Aug 2026)

## Solution proposée

1. Vérifier `eslint-config-next` flat config support (Next.js 16)
2. Migrer `apps/web/eslint.config.js` — supprimer `.eslintrc.json`
3. Idem `apps/studio` si applicable
4. `pnpm lint` uniforme

## Critères d'acceptation

- [ ] Single eslint.config.js per app
- [ ] `pnpm --filter @athlya/web lint` vert
- [ ] ACTION-ITEMS C3 closed
- [ ] Doc CONTRIBUTING.md lint section

## Priorité

**P3** — avant bump ESLint 10
