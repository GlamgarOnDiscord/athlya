# Contribuer à Athlya

Merci de prendre le temps. Ce document décrit comment proposer une contribution qui a de bonnes chances d'être mergée rapidement.

> **Avant tout** : Athlya est en phase active de développement (~277 / 313 tâches livrées — v1.1.0). Pour éviter les contributions en doublon ou hors-scope, ouvrir une **issue de discussion** avant de commencer un gros chantier.

---

## Table des matières

- [Avant de commencer](#avant-de-commencer)
- [Démarrer l'environnement de dev](#démarrer-lenvironnement-de-dev)
- [Workflow de contribution](#workflow-de-contribution)
- [Standards de code](#standards-de-code)
- [Tests](#tests)
- [Migrations SQL](#migrations-sql)
- [Nouveaux middlewares](#nouveaux-middlewares)
- [Commit & PR](#commit--pr)
- [Ce qui ne sera pas mergé](#ce-qui-ne-sera-pas-mergé)

---

## Avant de commencer

Lire dans cet ordre :

1. [`README.md`](README.md) — aperçu, architecture, état du projet
2. [`project.md`](project.md) — pitch, rationale de stack, principes directeurs
3. [`.kiro/specs/athlya-platform/requirements.md`](.kiro/specs/athlya-platform/requirements.md) — exigences fonctionnelles et non-fonctionnelles (format EARS)
4. [`.kiro/specs/athlya-platform/design.md`](.kiro/specs/athlya-platform/design.md) — choix techniques et algorithmes
5. [`.kiro/specs/athlya-platform/tasks.md`](.kiro/specs/athlya-platform/tasks.md) — plan d'implémentation, tâche par tâche
6. [`.kiro/specs/athlya-platform/PROGRESS.md`](.kiro/specs/athlya-platform/PROGRESS.md) — état d'avancement
7. [`critique.md`](critique.md) — auto-critique continue, décisions assumées

---

## Démarrer l'environnement de dev

### Prérequis

- **Node 24 LTS** — voir `.nvmrc`
- **pnpm 11** — `corepack enable` suffit (version lue dans `packageManager`)
- **Git** — avec configuration `user.name` et `user.email`
- **Docker** _optionnel_ — nécessaire uniquement pour les suites Testcontainers (RLS, cascade RGPD, booking property). Sans Docker, ces suites se skippent proprement

### Installation

```bash
git clone https://github.com/GlamgarOnDiscord/athlya.git athlya
cd athlya
pnpm install
git config core.hooksPath .githooks   # câble le hook pre-push (une seule fois par clone)
pnpm -r typecheck   # doit passer vert avant toute modification
pnpm -r test        # suites Docker-gated auto-skippées sans Docker
```

### Par package

```bash
pnpm --filter @athlya/api dev            # wrangler dev local
pnpm --filter @athlya/api test --watch   # développement interactif
pnpm --filter @athlya/api typecheck
```

---

## Workflow de contribution

### Branche

```bash
git checkout -b feat/epic-X.Y-description-courte
# ou
git checkout -b fix/description-courte
# ou
git checkout -b docs/description-courte
```

### Avant de pusher — `pnpm preflight`

```bash
pnpm preflight   # install --frozen-lockfile && format:check && lint && typecheck && test && build:ci
```

`preflight` couvre les gates principales du job CI requis
`Lint, typecheck, and tests` : `format:check`, `lint`, `typecheck`, la suite de
tests (les suites Docker-gated s'auto-skippent sans Docker) et le build
(`build:ci` = `SKIP_ENV_VALIDATION=1 pnpm build`, comme en CI). Les deux guards
du job (fichiers ignorés trackés / gros binaires, usage brut
d'`AthlyaDbHttp` hors `withTenantHttp`) ne tournent qu'en CI. Un rouge est donc
attrapé en local (Turbo-caché) dans la plupart des cas, au lieu d'un
aller-retour CI de ~5 min. Le hook
`.githooks/pre-push` (câblé par `git config core.hooksPath .githooks` lors du
setup initial — voir _Installation_ ci-dessus) le lance automatiquement —
bypass ponctuel : `git push --no-verify`.

Rappels :

- `format:check` est **repo-wide** : tout fichier tracké non formaté échoue.
  `pnpm format` corrige.
- Une dépendance retirée ⇒ `pnpm install` pour resynchroniser le lockfile
  (la CI utilise `--frozen-lockfile`).
- Derrière un proxy TLS d'entreprise / sandbox (`NODE_EXTRA_CA_CERTS`) :
  préfixer le push par `TURBO_ENV_MODE=loose`. Le mode env `strict` de Turbo
  (défaut) ne transmet aux tâches que les variables déclarées dans
  `turbo.json` et `PATH`/`SHELL`/`SYSTEMROOT`, donc le certificat CA est perdu.

### Dépôt public

Le dépôt est **public** :

- **Aucun secret** commité — `.dev.vars`, `.env*`, tokens, DSN, clés JWT.
  `gitleaks` tourne en CI (`secret-scan.yml`). Un secret poussé par erreur
  doit être **révoqué/roté**, pas seulement retiré de l'historique (voir
  [`docs/runbooks/rotate-secrets.md`](docs/runbooks/rotate-secrets.md)).
- Les workflows `pull_request_target` (ex. `dependabot-auto-merge.yml`)
  s'exécutent avec un token en écriture et les secrets : ils ne doivent
  **jamais** checkout ni exécuter le code de la PR. Utiliser `pull_request`
  pour tout ce qui build/teste du code contributeur.

### Ouvrir la PR

Le template de PR (`.github/PULL_REQUEST_TEMPLATE.md`) liste les items à vérifier. **Cocher chaque case** ou expliquer pourquoi ce n'est pas applicable.

Lier la PR à l'issue ou à la tâche concernée (`Closes #42` ou `Relates to Epic 8.9`).

### Reviews automatiques (obligatoire avant merge)

Les bots **CodeRabbit**, **cubic** et **Copilot** reviewent chaque PR. Avant de
merger **et** avant de fermer la PR/issue : lire **tous** leurs commentaires et
**appliquer les bons** (sécurité, bugs, perf, correctness) dans un commit de
suivi. Re-vérifier juste avant le merge — les reviews arrivent parfois après la
CI. Jamais de merge par-dessus un commentaire actionnable non traité.

### Merge

La protection de `master` (détail et commande de vérification dans
[`docs/runbooks/branch-protection.md`](docs/runbooks/branch-protection.md))
exige :

- le seul check requis `Lint, typecheck, and tests`, sur une branche à jour
  (mode strict) ;
- une review approbatrice d'un code owner (les reviews sont invalidées par un
  nouveau push) ;
- tous les threads de review résolus ;
- un historique linéaire (squash merge) ; force-push et suppression de
  `master` sont bloqués.

On merge uniquement quand **tous** les checks sont verts (pas seulement le check
requis), threads de review résolus. Exception : `Staging gate`,
`ZAP baseline scan (passive only)` et les tests de charge k6
(`book-class load test`, `list-classes load test`) échouent volontairement
(fail closed) tant que l'infra staging n'est pas provisionnée ; ils ne bloquent
pas le merge, mais un échec autre que le message « prérequis manquant » reste
une vraie régression. Les bumps dependabot minor/patch sont **groupés et
auto-mergés** (l'auto-merge attend aussi la review du code owner) ; les majors
sont testés en local puis revus manuellement.

#### Break-glass (bypass admin)

`enforce_admins` est à `false` : un admin peut merger par-dessus **toutes** les
règles de protection d'un coup (check requis, review, threads) avec :

```bash
gh pr merge <n> --squash --delete-branch --admin
```

GitHub interdit d'approuver sa propre PR et le seul code owner est
`@GlamgarOnDiscord` : une PR ouverte depuis ce compte ne peut donc pas obtenir
la review requise, et son merge passe par ce bypass. Avant de l'utiliser,
vérifier à la main ce qu'il ne vérifie plus : `Lint, typecheck, and tests` vert
sur le SHA de tête, threads résolus, reviews des bots appliquées.

Passer outre un check **rouge** n'est permis qu'en cas de flake CI **prouvé**
(timeout registre Docker, seed aléatoire du test `round-trip`, billing block).
Chaque utilisation de ce type doit être **documentée** (commentaire PR, lien
vers le run flake) pour préserver la traçabilité. Ne jamais l'utiliser pour
contourner un échec de code réel.

---

## Standards de code

### TypeScript

- **Strict mode** partout, `noUncheckedIndexedAccess` activé, `exactOptionalPropertyTypes` activé
- **`import type`** pour tous les imports de types
- **Aucun `any`** — utiliser `unknown` et narrower
- **`readonly`** par défaut sur les types publics

### Style

- **ESLint 9 flat config** partagé via `@athlya/eslint-config`
- **Prettier 3** via `@athlya/prettier-config`
- `pnpm format` avant chaque commit
- Préférer les fonctions nommées aux arrow functions pour les top-level exports (stack traces lisibles)

### Architecture

- **Packages domaine framework-free** — injection de dépendances via ports (Repo, Counter, Publisher, Store)
- **Hono est peerDependency optionnelle** de `@athlya/api` — les middlewares sont duck-typés sur `{ header(k,v); set; get; req; env }`
- **Zod `.strict()`** sur tous les bodies de requête, sauf `AuditLog.metadata` (volontairement open-ended)
- **Branded IDs** via `.transform()` (pas `Zod.brand()`)

### Documentation

- **JSDoc** sur tout export public
- Référencer les numéros de requirement (`Req 8.3`), de tâche (`task 8.11`) ou de hardening (`H5`) quand c'est pertinent
- Pas de commentaires triviaux (`// increment i`), oui aux "pourquoi" non-évidents

---

## Tests

### Niveaux attendus

| Type de changement      | Tests requis                                      |
| ----------------------- | ------------------------------------------------- |
| Nouveau middleware      | Unit + cas dans `middleware-chain.test.ts`        |
| Nouvel endpoint         | Unit du handler + integration via `app.request()` |
| Nouvelle migration SQL  | pgTAP + `.down.sql`                               |
| Nouvel invariant métier | Property-based test (fast-check, `numRuns` ≥ 20)  |
| Fix de bug              | Test qui échoue avant le fix et passe après       |

### Framework

- **Vitest 5** pour tout (unit, integration, PBT)
- **fast-check ^4** avec `@fast-check/vitest` pour les PBT
- **Playwright** + `@axe-core/playwright` pour l'E2E et l'accessibilité
  (`apps/*/e2e`, workflow `axe.yml`)
- Seeds hex fixes dans les PBT pour reproduction déterministe
- **Pas de mock réseau réel** — injecter les ports

### Testcontainers

Les suites qui dépendent de Postgres réel utilisent le pattern :

```ts
import { describeIfDocker } from '../../tests/helpers/docker.js';

describeIfDocker('property — no overbooking', () => {
  // ...
});
```

La sonde `docker info` synchrone au module load décide du skip. Toujours enregistrer un "infra probe test" qui vérifie que le fichier s'importe proprement, même sans Docker.

---

## Migrations SQL

**Règle absolue** : toute migration forward a un `.down.sql` qui reverse ses statements en ordre FK-safe.

Exemple :

```
packages/db/migrations/
├── 0000_init.sql                      # forward
├── 0000_init.down.sql                 # rollback
├── 0001_rls.sql
├── 0001_rls.down.sql
└── meta/
```

Les migrations sont générées par `drizzle-kit generate --name <descriptive-name>`. Les policies RLS, triggers et fonctions PL/pgSQL sont **hand-authored** (Drizzle ne les génère pas).

### Ne jamais

- Supprimer d'extension PostgreSQL (`pgcrypto`, `citext`) dans un `.down.sql` — elles sont cluster-shared
- Muter directement `audit_log` — passer par `anonymize_user_audit()` (migration 0003)
- Déployer une migration sans son test pgTAP correspondant

### Voir

- [`packages/db/migrations/README.md`](packages/db/migrations/README.md) pour la procédure complète
- [`packages/db/tests/rls/*.sql`](packages/db/tests/rls/) pour les patterns pgTAP

---

## Nouveaux middlewares

Tout nouveau middleware dans `@athlya/api` doit :

1. Vivre dans `packages/api/src/middleware/<name>.ts`
2. Être **framework-free** (duck-typer le contexte, ne pas importer Hono)
3. Exposer une factory `buildNameMiddleware(options)` qui retourne `async (c, next) => {...}`
4. Avoir son propre fichier de test `packages/api/src/__tests__/<name>.test.ts`
5. Avoir au moins **un cas dans `middleware-chain.test.ts`** qui exerce la composition avec les autres middlewares
6. Être ajouté à l'export map dans `packages/api/package.json`
7. Ne **pas** mounter automatiquement sur l'app globale — laisser la composition à l'intégrateur (worker.ts ou tests)

Référence : `security-headers.ts` pour le pattern de base, `auth.ts` pour un middleware qui écrit sur le contexte.

---

## Commit & PR

### Messages de commit

[Conventional Commits](https://www.conventionalcommits.org/) en anglais,
à l'impératif — c'est aussi le format des titres de PR squash-mergées :

```
feat(api): add JWT auth middleware (task 8.2)
fix(reservations): race condition in waitlist promotion
docs(readme): add hardening phase summary
```

Pas de semantic-release : le préfixe sert à la lisibilité de l'historique et du
CHANGELOG, pas à versionner.

### Titre de PR

Court (< 70 caractères), au format Conventional Commits (il devient le message
du squash-merge) ; la tâche ou l'épic va entre parenthèses si applicable :

```
feat(api): Turnstile verification middleware (Epic 8.9)
refactor(ratelimit): extract @athlya/ratelimit to break api↔auth cycle (H5)
docs: add LICENSE, SECURITY.md, CONTRIBUTING.md
```

### Corps de PR

Suivre le template. Au minimum :

- **Résumé** en 2-3 phrases
- **Ce qui change** (fichiers clés, pas tous)
- **Tests ajoutés** (combien, quoi)
- **Prérequis** (nouvelle env var, migration à appliquer, breaking change)
- **Risques / points d'attention** pour le reviewer

### Taille

- Cibler **< 500 lignes modifiées** par PR
- Les tâches des specs (Epic 8.3, H4, etc.) sont déjà découpées à cette granularité
- Si c'est gros, découper en plusieurs PR liées

### Changelog

Le [`CHANGELOG.md`](CHANGELOG.md) racine est **tenu à la main** (format
[Keep a Changelog](https://keepachangelog.com/)). Ajouter une entrée sous
`## [Unreleased]` pour tout changement notable (sécurité, feature, fix, breaking).
Il n'y a **pas** d'automatisation changesets : les `@athlya/*` sont des packages
internes (`workspace:*`) jamais publiés sur npm, donc rien à versionner/publier.

---

## Ce qui ne sera pas mergé

- PR avec `pnpm -r typecheck` ou `pnpm -r test` rouge
- PR avec `any` ou `@ts-ignore` sans justification documentée
- Nouveau middleware sans test de composition
- Migration SQL sans `.down.sql`
- Changement de contrat Zod sans bump du schema version
- Ajout d'une dépendance lourde (> 100 KB bundle Worker) sans benchmark
- Changement dans un invariant PBT sans mise à jour du property test
- Leak de secret dans les logs ou les réponses HTTP (la guard "secret-leak" est testée, ne pas la contourner)
- PR qui importe runtime `hono` dans un middleware (doit rester peerDependency)

---

## Questions

- Pour une discussion technique : ouvrir une issue avec le tag `discussion`
- Pour un rapport de bug : ouvrir une issue avec le template bug
- Pour une vulnérabilité de sécurité : **ne pas** ouvrir d'issue publique, ouvrir un [GitHub Security Advisory privé](https://github.com/GlamgarOnDiscord/athlya/security/advisories/new) (voir [`SECURITY.md`](SECURITY.md))

Merci de contribuer.
