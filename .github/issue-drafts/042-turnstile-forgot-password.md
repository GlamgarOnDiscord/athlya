## Résumé

Turnstile actif sur login/register. **Forgot-password** sans widget Turnstile en prod (checklist sécurité). Vecteur bot credential stuffing / email bombing.

**Finding audit** : S7 — gravité **Medium**, priorité **P1**.

## Comportement attendu

- `POST /v1/auth/forgot-password` exige token Turnstile valide en prod
- Même pattern que login (`turnstile-guard.ts`)
- Staging : bypass dev flag documenté

## Comportement observé

Route forgot-password sans guard Turnstile → spam reset emails, énumération users amplifiée.

## Solution proposée

1. Ajouter middleware Turnstile sur route forgot-password
2. Front web/studio : widget Turnstile sur formulaire reset
3. Test E2E : sans token → 403
4. Mettre à jour checklist launch

## Composants touchés

- [ ] `packages/api/src/routes/auth.ts` (ou équivalent)
- [ ] `apps/web` forgot password form
- [ ] `apps/studio` si applicable

## Critères d'acceptation

- [ ] Prod reject sans Turnstile
- [ ] UX widget fonctionnel web
- [ ] Test API + E2E
- [ ] Checklist sécurité cochée

## Références

- `packages/api/src/middleware/turnstile-guard.ts`
- `docs/security/README.md`
- Audit prod 2026-05-27 — S7

## Priorité

**P1** — avant ouverture publique auth
