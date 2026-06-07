## Résumé

Issue tracking pour les **17+ findings audit résiduels** (MEDIUM/LOW/INFO) non résolus code-side. Score « 96/100 » = partiel.

Source : `docs/security/README.md` Sprint 9 — 12/23 MEDIUM, 4/21 LOW.

## Backlog à trier

### Ops-only (ne pas coder ici)

- [ ] HSTS preload submission (S4-009)
- [ ] TurnstileWidget ForgotPasswordForm (bloqué Turnstile prod)
- [ ] DPO email placeholder
- [ ] Re-audit 12 mois

### Code nice-to-have (extraire du audit)

Consulter :

- `docs/security/AUDIT-SUMMARY.md`
- `docs/security/audit-S1-static.md` through `audit-S6-frontend.md`
- `docs/modifications/modifications.md` Vagues 24-37

Filtrer items avec status ≠ ✅ code-side.

## Solution proposée

1. Export CSV findings → GitHub sub-issues ou checklist cette issue
2. Prioriser P2/P3 par impact × effort
3. Sprint dédié « audit cleanup » post-prod 6 mois (déjà planifié README)

## Critères d'acceptation

- [ ] Chaque finding MEDIUM ouvert a une issue fille ou ligne checklist
- [ ] `docs/security/README.md` tableau à jour
- [ ] Pas de findings CRITICAL/HIGH ouverts (déjà ✅)

## Priorité

**P2** tracking — exécution P2/P3 item par item

## Template sous-issue

```
[audit] S*-*** — <titre finding>
Labels: security, priority: medium
Body: lien audit-S*.md section + AC
```
