## Résumé

Issue #75 a migré `BrandingPreview` vers CSS variables. **`style-src-attr 'unsafe-inline'` toujours requis** pour `sonner`, `@base-ui-components/react`, et autres libs tierces.

**Finding audit** : S3 — gravité **Medium**, priorité **P2**.

## Impact

XSS via injection attributs style possible si HTML injecté contourné.

## Solution proposée

### Option A — Remplacer libs

Toast alternative sans inline styles (radix sans style attr)

### Option B — Nonce/hash style-src-attr

CSP level 3 — vérifier support navigateurs cibles

### Option C — Accept risk documenté

DPIA + durcissement sanitization HTML strict

## Critères d'acceptation

- [ ] Inventaire libs requiring style-src-attr
- [ ] Soit directive retirée, soit risk accepté signé + doc
- [ ] ZAP scan sans régression

## Références

- `apps/web/src/lib/csp.ts` L97-115
- Issue fermée #75 (partiel)
- Audit prod 2026-05-27 — S3

## Priorité

**P2**
