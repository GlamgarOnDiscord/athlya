# ADR — CSP `style-src-attr 'unsafe-inline'` (issue #137 / audit S3)

**Statut** : accepté — risque documenté (Option C)
**Date** : 2026-05-31
**Décideurs** : CTO (sécurité) — réévaluation à l'audit J+12 mois
**Finding** : audit prod 2026-05-27 S3 (Medium) — suite partielle de #75

## Contexte

La CSP des apps web émet `style-src 'self' 'nonce-…'` (les `<style>` blocks non-noncés sont **bloqués**) mais conserve une directive séparée `style-src-attr 'unsafe-inline'` (`apps/web/src/lib/csp.ts` L97-115). Cette directive autorise les **attributs** `style="…"` inline injectés au runtime par des dépendances tierces.

### Inventaire des libs exigeant `style-src-attr 'unsafe-inline'`

| Lib                | Version            | Usage Athlya                                      | Inline `style=""` runtime                                                                                           |
| ------------------ | ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sonner`           | ^2.0.7             | Toasts (`components/ui/sonner.tsx`, `layout.tsx`) | Oui — `--index`, `--toasts-before`, `transform`, `opacity`, `height` sur chaque `<li>` toast (animation/empilement) |
| `@base-ui/react`   | ^1.5.0             | Popover, Select, Menu, Tooltip positionnés        | Oui — `transform`/`top`/`left` injectés par le moteur d'ancrage (floating positioning)                              |
| `react-day-picker` | (transitif via UI) | Sélecteur de date                                 | Styles d'attribut ponctuels                                                                                         |

Ces styles sont **dynamiques** (valeurs calculées à chaque frame d'animation / repositionnement), donc ni un hash CSP (`'unsafe-hashes'` + hash figés) ni un nonce d'attribut ne s'appliquent.

## Décision

**Conserver `style-src-attr 'unsafe-inline'`** et **accepter le risque résiduel** (Option C), plutôt que :

- **Option A (remplacer les libs)** — rejetée : réécrire toasts + positionnement (sonner + Base UI) est un chantier majeur disproportionné pour un risque Medium, et les alternatives (Radix, etc.) injectent les mêmes styles d'attribut dynamiques.
- **Option B (nonce/hash sur `style-src-attr`)** — rejetée : **infaisable techniquement**. CSP3 ne supporte pas les nonces sur attributs `style`. `'unsafe-hashes'` exigerait de hasher chaque valeur de style, impossible pour des `transform`/`--index` calculés dynamiquement.

## Analyse du risque résiduel — **LOW**

`style-src-attr 'unsafe-inline'` n'autorise **que** les attributs `style=""`. Il **n'autorise pas** :

- l'exécution de script (`script-src 'nonce-…' 'strict-dynamic'` reste strict, pas de `'unsafe-inline'`),
- les `<style>` blocks non-noncés (`style-src` reste nonce-gated),
- `data:`/`javascript:` dans les sources.

Impact théorique d'une injection d'attribut `style` (suppose **déjà** un vecteur d'injection HTML) : CSS exfiltration via sélecteurs d'attribut, UI redressing. **Pas** d'exécution de code.

### Contrôles compensatoires en place

1. **React auto-escaping** sur tout le rendu — aucun `dangerouslySetInnerHTML` dans `apps/web/src` (vérifié, 0 occurrence).
2. **`script-src` strict** (`'nonce' 'strict-dynamic'`, pas de `'unsafe-inline'`) → une injection HTML ne peut pas exécuter de JS.
3. **`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`** → surface d'attaque réduite.
4. Entrées utilisateur validées Zod côté API + web ; pas de rendu HTML brut d'input.

Le pré-requis (injection HTML aboutie) est lui-même neutralisé par #1 et #2, ce qui ramène la probabilité d'exploitation à **faible**.

## Conséquences

- `apps/web/src/lib/csp.ts` documente le lien vers cet ADR (commentaire L97+).
- Test `csp.test.ts` verrouille la posture : `style-src-attr 'unsafe-inline'` présent en prod **sans** élargir `style-src` (qui reste nonce-gated) — empêche une dérive silencieuse.
- **ZAP baseline** : pas de régression attendue (la directive existait déjà ; aucune nouvelle source ajoutée). Rejouer `zaproxy/action-baseline` sur preview avant prod.

## Déclencheurs de réévaluation

- Sonner / Base UI publient un mode sans inline-style (ou support nonce d'attribut natif navigateurs cibles).
- Ajout d'un vecteur de rendu HTML non-React (markdown utilisateur, emails rendus client, etc.) → re-scoper.
- Audit J+12 mois (cf. `docs/security/README.md`).

## Références

- `apps/web/src/lib/csp.ts` L97-115
- Issue #75 (migration BrandingPreview → CSS variables, partielle)
- `docs/security/audit-S3-dast.md` — finding S3
- `docs/security/dpia-template.md`
