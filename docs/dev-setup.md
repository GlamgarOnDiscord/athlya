# Dev Setup — Athlya

Checklist pour démarrer la stack en local (API Workers + Web Next.js).

## Prérequis

- Node.js **24 LTS** (voir `.nvmrc`)
- pnpm **11** (`corepack enable` — la version est lue dans `packageManager`)
- PowerShell sur Windows (les scripts sont cross-platform, mais les exemples sont PS)
- Docker (optionnel, uniquement si tu veux lancer Postgres/Redis en local au lieu de Neon/Upstash)
- Comptes SaaS : Neon (Postgres), Upstash (Redis REST), Cloudflare (Turnstile), Sentry (optionnel en dev)

## Install

```powershell
pnpm install
```

## Secrets & variables d'environnement

### 1. Générer la paire de clés JWT

```powershell
node scripts/generate-jwt-keypair.mjs
```

Copier les clés dans `packages/api/.dev.vars` (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY).

### 2. Remplir `packages/api/.dev.vars`

Variables minimales :

- `DB_URL` — chaîne de connexion Neon (pooled, `sslmode=require`)
- `REDIS_URL` — URL REST Upstash (`https://...upstash.io`)
- `REDIS_TOKEN` — token REST Upstash
- `TURNSTILE_SECRET` — secret Cloudflare Turnstile
- `SENTRY_DSN` — laisser **vide** en dev
- `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` — générées à l'étape précédente

### 3. Remplir `apps/web/.env.local`

Copier depuis l'exemple :

```powershell
Copy-Item apps/web/.env.local.example apps/web/.env.local
```

Puis ajuster les valeurs (API URL, Turnstile site key, etc.).

## Base de données

### Migrer le schéma

Le script lit `DATABASE_URL` depuis l'environnement :

```powershell
$env:DATABASE_URL = "postgres://..."
node packages/db/scripts/migrate.mjs
```

### Seed de dev

```powershell
node packages/db/scripts/seed-dev.mjs
node packages/db/scripts/seed-classes.mjs
```

Le premier crée les users de test (Alice, Bob, admin). Le second crée le catalogue de cours et quelques sessions à venir.

## Lancer les serveurs

Deux terminaux :

```powershell
# Terminal 1 — API (Workers, port 8787)
pnpm --filter @athlya/api dev

# Terminal 2 — Web (Next.js, port 3000)
pnpm --filter @athlya/web dev
```

## Vérifier le flow d'auth

1. Ouvrir http://localhost:3000/register
2. Créer Alice (email + mot de passe fort, non-HIBP)
3. Se connecter sur http://localhost:3000/login
4. Vérifier `/me` (profil + consents)
5. Vérifier `/classes` (liste des sessions seedées)

Si l'un de ces points échoue, voir `docs/runbooks/login-fails.md`.
