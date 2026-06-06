# Athlya — règles de workflow (agents & humains)

Document de référence pour enchaîner les issues CTO, ouvrir des PRs propres et merger sans bruit.  
Dernière mise à jour : 2026-05-31 (post #135–#142).

> **État backlog (2026-05-31)** : toutes les issues codables sont mergées (#135 reconcile capacity, #136 CSP sink, #137 ADR style-src-attr, #138 Sentry source maps, #139 ADR deploy web, #140 circuit breaker jitter, #141 cap DO WS, #142 dep tmp). Seule **#123 reste ouverte** — bloquée hors-code par le billing GitHub Actions (cf. `docs/runbooks/ci-recovery.md`).

---

## 1. Ordre de travail

- Traiter les issues **dans l’ordre numérique CTO** (#126, #127, #128, …) sauf blocage explicite.
- **Une issue = une branche = une PR** ; ne pas mélanger plusieurs tickets dans le même diff.
- Avant de coder : lire l’issue GitHub + le draft `.github/issue-drafts/` s’il existe.
- Après merge : commentaire de clôture détaillé sur l’issue, puis `master` à jour avant la suivante.

---

## 2. Branches

```text
fix/issue-<num>-<slug-court>
```

Exemples : `fix/issue-127-audit-log-wiring`, `fix/issue-128-global-rate-limit-fail-closed-soft`.

- Toujours partir de `master` à jour.
- Push avec `-u origin HEAD` sur la première fois.

---

## 3. Métadonnées PR (obligatoire)

Créer **avant** la PR GitHub :

| Fichier                            | Contenu                                     |
| ---------------------------------- | ------------------------------------------- |
| `.github/pr/issue-<num>-title.txt` | Titre squash (1 ligne, convention commits)  |
| `.github/pr/issue-<num>-body.md`   | Summary + `Closes #<num>` + test plan coché |

Création PR :

```powershell
gh pr create --title (Get-Content -Raw .github/pr/issue-XXX-title.txt).Trim() `
  --body (Get-Content -Raw .github/pr/issue-XXX-body.md) --base master
```

---

## 4. Commits

### À faire

- Messages clairs, orientés **why** : `fix(api): … (#127)`.
- Stager **uniquement** les fichiers du ticket (`git add <paths>` — jamais `git add -A` aveugle).
- Vérifier `git status` avant commit.

### À ne pas faire

- **Jamais** « Made with Cursor », co-author Cursor, ou mention de l’IDE dans commits / PR / squash body.
- L’env local peut injecter `Co-authored-by: Cursor <cursoragent@cursor.com>` : **ne pas s’y fier**.
- Contournement : **squash merge** avec `--subject` et `--body` propres (sans co-author).
- Ne pas committer `.env`, secrets, `.claude/`, `.github/issue-drafts/` non demandés.
- Ne pas committer sans demande explicite de l’owner (sauf fin de ticket dans ce workflow agent).

Exemple merge propre :

```powershell
gh pr merge <num> --squash --admin `
  --subject "fix(api): brancher audit_log JWT rotate, DLQ et webhooks Stripe (#127)" `
  --body "Closes #127"
```

- Utiliser si possible des fichiers temporaires pour faire body et subject propre (sinon problèmes caractères spéciaux etc..)

---

## 5. Review bot (obligatoire)

**Gate review = CodeRabbit** (free illimité sur repo public ; crédits Copilot épuisés depuis #134). Copilot reste actif en review auto si dispo, mais n'est plus le gate.

Workflow **non négociable** sur chaque PR :

1. Commenter sur la PR : `@coderabbitai review` (auto sur push aussi)
2. **Attendre ~5 minutes** minimum
3. Lire walkthrough + commentaires inline (`gh api repos/.../pulls/<num>/comments`, et `gh pr view <num> --json reviews,comments`)
4. Appliquer les fixes pertinents
5. Recommit + push
6. Re-attendre si gros changements ; sinon merger quand review OK ou sans commentaires bloquants

Ne pas merger sans avoir lu le retour CodeRabbit (+ Copilot si présent).

---

## 6. Qualité avant PR

Minimum sur le périmètre touché :

```powershell
pnpm exec tsc --noEmit -p packages/api   # si API
pnpm --filter @athlya/api test -- src/__tests__/....test.ts
```

- Diff minimal : pas de refacto hors scope.
- Suivre les conventions du fichier (noms, imports, patterns existants).
- Tests utiles seulement (comportement réel, pas assert triviaux).
- Mettre à jour runbooks / checklists si le ticket est ops.

---

## 7. CI & merge

- CI GitHub Actions peut être **bloquée par le quota billing** (issue #123) → jobs en ~3s sans logs.
- Runbook : [`docs/runbooks/ci-recovery.md`](docs/runbooks/ci-recovery.md)
- Si tests locaux verts + CodeRabbit OK : merge **`--admin --squash`** acceptable en attendant le quota.
- Ne pas `--force-push` sur `master`.

---

## 8. Clôture issue

Après merge :

```powershell
gh issue comment <num> --body "<résumé livrable, fichiers clés, tests, lien PR>"
gh issue close <num> -r completed
```

Le commentaire doit permettre à un autre dev de comprendre **quoi** a été livré sans relire tout le diff.

---

## 9. Patterns récurrents (issues ops / sécu)

| Type           | Livrables typiques                                                         |
| -------------- | -------------------------------------------------------------------------- |
| Ops / alerting | runbook `docs/runbooks/…`, script `scripts/verify-….mjs`, checklist launch |
| Sécu API       | code + tests unit/intégration + doc `docs/security/`                       |
| Wiring admin   | lazy deps Worker, audit_log, tests routes admin                            |

Inventaires (ex. monitors Axiom) : **compter et aligner** doc + script verify + checklist (ne pas laisser 13 vs 14).

---

## 10. Git / GitHub — interdits

- `git config` (user ne doit pas être modifié par l’agent)
- `git push --force` sur `master` / `main`
- `git commit --amend` sauf cas très précis (hook auto-fix, commit non poussé, demande explicite)
- `--no-verify` sauf demande explicite
- Push remote sauf demande ou workflow PR ci-dessus

Toutes les opérations GitHub via **`gh`** (issues, PR, checks, merge).

---

## 11. PowerShell (Windows)

- Enchaîner avec `;` plutôt que `&&` (non supporté partout).
- Messages multi-lignes : fichiers `.github/pr/` ou here-strings PowerShell.

---

## 12. Références

| Sujet             | Où                                           |
| ----------------- | -------------------------------------------- |
| Drafts issues CTO | `.github/issue-drafts/`                      |
| CI quota          | #123, `docs/runbooks/ci-recovery.md`         |
| Launch checklist  | `docs/operations/v1.0.0-launch-checklist.md` |
| Action items      | `docs/ACTION-ITEMS.md`                       |

---

## Checklist rapide (copier par ticket)

- [ ] Issue lue + draft consulté
- [ ] Branche `fix/issue-N-…` depuis `master`
- [ ] Code + tests locaux verts
- [ ] `.github/pr/issue-N-title.txt` + `body.md`
- [ ] Commit ciblé (pas de fichiers parasites)
- [ ] PR créée
- [ ] `@coderabbitai review` → **5 min** → fixes → push
- [ ] Squash merge message propre (sans Cursor)
- [ ] Issue commentée + fermée
- [ ] `git checkout master && git pull`
