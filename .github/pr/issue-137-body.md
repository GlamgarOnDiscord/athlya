## Contexte

Issue #137 (P2 security, audit S3). `style-src-attr 'unsafe-inline'` reste requis après #75 (migration BrandingPreview → CSS vars) pour les libs tierces qui injectent des styles d'attribut **dynamiques** au runtime.

## Inventaire

| Lib                     | Usage                       | Inline `style=""` runtime                          |
| ----------------------- | --------------------------- | -------------------------------------------------- |
| `sonner` ^2.0.7         | toasts                      | `--index`/`transform`/`opacity`/`height` par toast |
| `@base-ui/react` ^1.5.0 | popover/select/menu/tooltip | `transform`/`top`/`left` (positionnement)          |
| `react-day-picker`      | datepicker                  | styles d'attribut ponctuels                        |

## Décision — Option C (risque accepté, documenté)

- **Option B (nonce/hash)** rejetée : **infaisable** — CSP3 ne nonce pas les attributs `style`, et les valeurs sont dynamiques (pas de hash figé possible).
- **Option A (remplacer libs)** rejetée : chantier disproportionné, alternatives = même problème.
- **Option C** : conserver la directive, risque résiduel **LOW** documenté.

Risque borné : `style-src-attr` n'élargit **que** les attributs `style` — pas `script-src` (reste `'nonce' 'strict-dynamic'`), pas les `<style>` non-noncés (`style-src` reste nonce-gated). Contrôles compensatoires : React auto-escaping (**0** `dangerouslySetInnerHTML` dans `apps/web/src`), script-src strict, validation Zod.

## Changements

- **`docs/security/csp-style-src-attr-adr.md`** — ADR complet (inventaire, options rejetées, analyse risque, contrôles compensatoires, déclencheurs de réévaluation).
- **`csp.ts`** — commentaire L97+ pointe vers l'ADR.
- **`csp.test.ts`** — 3 tests verrouillent la posture : `style-src-attr 'unsafe-inline'` présent en prod, `style-src` reste nonce-gated (pas élargi), pas de `style-src-attr` en dev.
- **`audit-backlog.md`** S6-001 → résolu (risk accepté), **`security/README.md`** lien ADR.

## Critères d'acceptation

- [x] Inventaire libs requiring style-src-attr
- [x] Risk accepté signé + doc (ADR)
- [x] ZAP scan sans régression — aucune nouvelle source CSP ; rejouer `zaproxy/action-baseline` sur preview avant prod (noté ADR)

Closes #137
