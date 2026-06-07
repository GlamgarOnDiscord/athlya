## Résumé

CSP production autorise `style-src-attr 'unsafe-inline'` (Sprint 3 SP3.1, finding S6-001) pour supporter `style={{}}` React (`BrandingPreview`). Affaiblissement XSS partiel — injection attribute styles possible si HTML injecté.

## Fichiers concernés

- `apps/web/src/lib/csp.ts` L97-115
- `apps/studio/src/...` (même pattern si applicable)
- `BrandingPreview` — couleur tenant inline

## Solution proposée

### Option 1 — CSS variables (recommandée audit)

```tsx
<div style={{ '--brand': color } as CSSProperties} className="brand-preview" />
```

```css
.brand-preview {
  background: var(--brand);
}
```

Retirer `style-src-attr 'unsafe-inline'` en prod.

### Option 2 — nonce sur style attributes

Non supporté CSP level — abandon.

## Critères d'acceptation

- [ ] BrandingPreview sans inline style attributes
- [ ] CSP prod sans `style-src-attr 'unsafe-inline'`
- [ ] E2E branding page visuellement identique
- [ ] audit-S6-frontend.md finding S6-001 closed

## Priorité

**P2**
