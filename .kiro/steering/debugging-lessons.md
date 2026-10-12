---
inclusion: manual
---

# Leçons de debug — Rétro PR #18 (revert deps majors, mai 2026)

**Contexte** : PR #18 bumpait 4 majors d'un coup (vitest 3→4, lighthouse
12→13, react-hooks 5→7, globals 16→17). Le revert + cleanup a pris ~2h30
au lieu de ~45 min nécessaires. Cette fiche capture les leçons à
appliquer sur les prochaines investigations CI.

## Les 5 erreurs à ne PAS refaire

### 1. Ne pas présumer "régression" sans vérifier la baseline

**Symptôme observé** : 3 jobs CI rouges sur la PR.
**Présomption (fausse) que j'ai prise** : « ces fails sont causés par
les bumps majors ».
**Vérification que j'aurais dû faire AVANT** :

```bash
gh run list --branch master --workflow=CI --status success --limit 5
```

Si zéro résultat → **master n'a jamais été vert**, donc les "fails de
la PR" sont en fait des bugs latents pré-existants. Le scope du fix
change complètement : ce n'est plus un revert, c'est une triage entre
"vraies régressions du PR" et "bombes à retardement de master".

**Règle** : avant de débugger une PR rouge, **toujours** vérifier que
master est vert. Si master n'est pas vert, le scope du fix est plus
large et il faut décider en amont si on absorbe les fails latents ou
on les skip explicitement.

### 2. Reproduire EN LOCAL avant de push-and-pray

**Coût d'un cycle CI** : 5-7 min (queue + install + build + tests).
**Coût d'un push qui échoue** : 1 cycle CI + diagnostic + nouveau commit
+ nouveau push + nouveau cycle = ~15-20 min net pour valider une
hypothèse.
**Coût d'un repro local** : démarrer Docker (1 min) + lancer le test
ciblé (30s à 2 min) = ~3 min max.

**Règle** : si un test fail en CI et qu'il est reproductible en local
(Docker, Testcontainers, ou jsdom), **toujours** reproduire en local
AVANT de push un fix spéculatif. Le ratio coût/bénéfice du push-and-pray
est catastrophique au-delà du 2e push.

**Exception légitime** : tests qui dépendent de secrets CI ou
d'environnement Linux que Windows ne reproduit pas. Là, push-and-pray
est OK mais avec un commit message explicite "tentative N — hypothèse X".

### 3. Lire l'historique des commits AVANT de toucher au code

**Symptôme** : j'ai introduit un workaround `scalar-guard` pour
`anonymize_user_audit` en pensant l'inventer. **En fait, le commit
`eb2a3b5` 5 commits plus tôt sur la branche avait déjà ce workaround**,
et le commit `97df81e` (suivant) l'avait retiré pour appeler la fonction
SQL directement.

**Règle** : sur une branche avec >5 commits "fix:", **lire les commit
messages dans l'ordre chronologique** (`git log master..HEAD --reverse
--oneline`) avant de proposer un fix. Souvent le bug a déjà été
diagnostiqué et un workaround existe dans l'historique.

```bash
# Réflexe à avoir au début d'une investigation sur une branche
# avec un PR qui traîne :
git log master..HEAD --reverse --oneline
git log master..HEAD --reverse --format='%h %s%n%b%n---'  # avec messages complets
```

### 4. Filtrer les logs CI dès la première lecture

**Symptôme** : `gh run view --log-failed` retourne des MB de NOTICE
Postgres "policy does not exist, skipping" qui noient la ligne d'erreur
réelle. J'ai cherché dans les mauvais blocs plusieurs fois.

**Règle** : toujours filtrer les logs CI sur les marqueurs vitest /
playwright précis dès la première extraction :

```bash
# Pour vitest (vraie ligne de fail) :
gh run view --job <id> --log-failed | grep -E '✗|FAIL|❯ tests|❯ src|expected.*to|exited \(1\)|Property failed|Counterexample'

# Pour playwright :
gh run view --job <id> --log-failed | grep -E 'Error:|Locator:|element\(s\) not found|expect\(.*\)\.|FAIL'

# Bilan compteurs vitest :
gh run view --job <id> --log-failed | grep -E 'Test Files\s+\d|Tests\s+\d|Failed:'
```

**À éviter** : les pipes PowerShell `Select-String -Pattern '...' -Context 0,3`
qui retournent des kilomètres de contexte. Préférer des regex étroites
qui matchent juste les marqueurs de fail vitest/playwright.

### 5. Respecter la règle "2 tentatives puis recule"

Le system prompt Kiro dit : « si une approche a échoué deux fois,
diagnostiquer la cause profonde plutôt qu'enchaîner les patches
incrémentaux ». Sur la cascade integration j'ai fait 3 tentatives
(workaround scalar-guard → ajout migration 0003 → retrait migration
0003) avant de skip, en empilant des modifs qui se cancelaient
mutuellement.

**Règle** : après 2 fails consécutifs sur le même test :
1. Stop. Pas de 3e push.
2. Diagnostic root cause complet (lire le code prod, lire l'historique,
   reproduire local).
3. Si le scope dépasse l'objectif courant → `describe.skip` avec
   commentaire JSDoc + fiche de suivi dans `docs/runbooks/`.
4. Confirmer avec l'utilisateur avant le 3e push.

## Les 4 vrais bugs profonds rencontrés (à retenir)

Pour information sur les patterns de bugs latents qui peuvent traîner
dans le repo :

### a) `anonymize_user_audit(uuid)` plante sur metadata scalar

Migration `0003_audit_anonymization.sql` ligne ~244 :
```sql
metadata = metadata - 'email' - 'displayName' - 'ip' - 'userAgent'
```

L'opérateur `-` JSONB **plante** sur scalar (SQLSTATE 22023).
Le `WHERE (metadata ? 'subjectUserId' …)` aussi.

**[PROD-RISK]** : la première row scalar dans audit_log fait crasher
le worker RGPD J+30. Fix proposé : guard `WHEN jsonb_typeof(metadata)
= 'object'`.

À reprendre dans une PR migration `0006_anonymize_audit_scalar_guard.sql`
quand la fenêtre se présentera.

### b) jsdom 26 n'a pas `PointerEvent`

base-ui v1.x Checkbox utilise `PointerEvent` dans son onClick. Sans
polyfill, tout test qui clique un Checkbox crash avec
`ReferenceError: PointerEvent is not defined`.

Fix appliqué : `apps/web/vitest.setup.ts` polyfill (étend MouseEvent
avec les props PointerEventInit).

**Mise à jour 2026-10 :** jsdom 30 implémente `PointerEvent` nativement ;
le polyfill et `vitest.setup.ts` ont été supprimés.

### c) pnpm strict mode ne hoist pas les transitives

`lighthouse 12` embarque `chrome-launcher` en transitive, mais pnpm
en strict mode (notre config) ne le hoist pas dans
`apps/web/node_modules`. Le script `lighthouse-check.js` qui fait
`import { launch } from 'chrome-launcher'` plante avec
`Cannot find package`.

Fix appliqué : déclarer `chrome-launcher` en devDep directe dans
`apps/web/package.json`.

**Pattern récurrent** : tout script qui importe une lib transitive
doit la déclarer en direct dep. À ajouter à la review de toute
nouvelle dépendance.

### d) Playwright `webServer` est tué entre les steps CI

Le job `axe + Lighthouse` lançait Playwright (qui démarre `next dev`
via `webServer` config) pour axe.spec.ts, puis appelait
`pnpm lighthouse` qui suppose un serveur sur :3000. Mais Playwright
**tue son webServer** à la fin de chaque run, donc lighthouse
trouvait un port mort (score 0).

Fix appliqué : `next start` background dans le workflow axe.yml entre
les 2 steps + kill explicit en cleanup.

**Pattern récurrent** : tout job CI qui chaîne 2 outils de browser
testing doit gérer son propre webServer entre les steps, pas
s'appuyer sur celui de Playwright.

## Checklist debug d'une PR rouge

À dérouler dans cet ordre AVANT toute modif de code :

- [ ] `git status` propre, branche correcte
- [ ] `gh pr checks <N>` — quels jobs fail, combien, depuis combien de temps
- [ ] `gh run list --branch master --workflow=CI --status success --limit 5`
      → si vide, master n'est pas vert, élargir le scope
- [ ] `git log master..HEAD --reverse --oneline` — lire les commit
      messages dans l'ordre chronologique
- [ ] `gh run view --job <id> --log-failed | grep -E '<marqueurs vitest/playwright>'`
      pour extraire la vraie ligne d'erreur
- [ ] Reproduire en local si possible (Docker disponible, Playwright
      install OK)
- [ ] Énumérer hypothèses, choisir la moins coûteuse à tester
- [ ] **Au-delà de 2 tentatives sur le même test** → stop, diagnostic
      root cause OU skip avec runbook
- [ ] Commit messages explicites sur quelle hypothèse on teste
- [ ] Avant de merger : tous les `describe.skip` ont une fiche dans
      `docs/runbooks/` qui décrit comment reprendre
