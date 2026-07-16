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

- **Node 22 LTS** — voir `.nvmrc`
- **pnpm ≥ 9** — `corepack enable` suffit
- **Git** — avec configuration `user.name` et `user.email`
- **Docker** _optionnel_ — nécessaire uniquement pour les suites Testcontainers (RLS, cascade RGPD, booking property). Sans Docker, ces suites se skippent proprement

### Installation

```bash
git clone https://github.com/GlamgarOnDiscord/athlya.git athlya
cd athlya
pnpm install
git config core.hooksPath .githooks   # câble le hook pre-push (une seule fois par clone)
pnpm -r typecheck   # doit passer vert avant toute modification
pnpm -r test        # ~807 tests en ~30 s
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
pnpm preflight   # install --frozen-lockfile && format:check && lint && typecheck
```

`preflight` reproduit les gates **rapides et déterministes** du job CI requis
`Lint, typecheck, and tests` — soit `format:check`, `lint`, `typecheck` (mais
**pas** la suite de tests, qui ne tourne qu'en CI). Un rouge déterministe est
donc attrapé en local en ~30 s au lieu d'un aller-retour CI de ~5 min ; lance
`pnpm -r test` toi-même si ton changement touche de la logique. Le hook
`.githooks/pre-push` (câblé par `git config core.hooksPath .githooks` lors du
setup initial — voir _Installation_ ci-dessus) le lance automatiquement —
bypass ponctuel : `git push --no-verify`.

Rappels :

- `format:check` est **repo-wide** : tout fichier tracké non formaté échoue.
  `pnpm format` corrige.
- Une dépendance retirée ⇒ `pnpm install` pour resynchroniser le lockfile
  (la CI utilise `--frozen-lockfile`).

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

On merge uniquement quand **tous** les checks sont verts (pas seulement le check
requis), threads de review résolus. Les bumps dependabot minor/patch sont
**groupés et auto-mergés** ; les majors sont testés en local puis revus
manuellement.

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

- **Vitest 3** pour tout (unit, integration, PBT)
- **fast-check ^3.23.2** avec `@fast-check/vitest` pour les PBT
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

Format libre mais concis. Préférer l'impératif :

```
Add JWT auth middleware (task 8.2)
Fix race condition in waitlist promotion
Update README with hardening phase summary
```

Pas besoin de Conventional Commits — le projet n'utilise pas de semantic-release.

### Titre de PR

Court (< 70 caractères), descriptif, préfixé par la tâche ou l'épic si applicable :

```
[Epic 8.9] Turnstile verification middleware
[H5] Extract @athlya/ratelimit to break api↔auth cycle
[docs] Add LICENSE, SECURITY.md, CONTRIBUTING.md
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
- Pour une vulnérabilité de sécurité : **ne pas** ouvrir d'issue, écrire à security@athlya.app (voir [`SECURITY.md`](SECURITY.md))

Merci de contribuer.
