# Hyperdrive provisioning — Neon write path (issue #119)

**Owner:** Backend / SRE  
**Prérequis:** Migration `0004_rls_hardening.sql`, rôle `athlya_app` provisionné, `DB_URL` cutover planifié ou fait (#117).

---

## Pourquoi

Le hot path `bookClass` / `cancelReservation` utilise postgres-js TCP. Sans Hyperdrive, `getOrCreateWriteDb()` ouvre **`maxConnections: 1` par requête** — TLS Neon à chaque booking (~50–500 ms cold). SLO p99 < 500 ms non tenable.

Avec Hyperdrive, le client est **cacheable par isolate** (`deps-cache.ts`, pool `max: 3`).

`/health/ready` retourne **503** en staging/production si `HYPERDRIVE` n'est pas bound (probe `skipped` = fail-closed hors dev).

---

## Étapes

### 1. Créer la config Hyperdrive (Cloudflare Dashboard)

1. **Workers & Pages → Hyperdrive → Create configuration**
2. **Origin:** PostgreSQL
3. **Connection string:** URL **`athlya_app`** (pas owner) — même host Neon que `DB_URL`, user `athlya_app`
4. **Région:** EU (`aws-eu-central-1` ou closest Neon EU PoP)
5. Noter le **config ID** (UUID)

Répéter pour **staging** et **production** (deux configs distinctes recommandées).

### 2. Activer le binding wrangler

Décommenter et remplir dans `packages/api/wrangler.toml` :

```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "<staging-hyperdrive-config-id>"

[[env.production.hyperdrive]]
binding = "HYPERDRIVE"
id = "<production-hyperdrive-config-id>"
```

### 3. Déployer

```powershell
cd packages/api
pnpm exec wrangler deploy --env staging
pnpm exec wrangler deploy --env production
```

### 4. Valider readiness

```powershell
curl -s https://api-staging.athlya.app/health/ready | jq .
# checks.hyperdrive.status == "ok"

./scripts/wait-health-ready.sh https://api-staging.athlya.app
```

Corps attendu (extrait) :

```json
{
  "status": "ready",
  "checks": {
    "hyperdrive": { "status": "ok", "latencyMs": 12 }
  }
}
```

Si `hyperdrive.status` = `skipped` → binding absent ou deploy sans section hyperdrive.

### 5. Charge (staging)

```powershell
# Prérequis: K6_STAGING_BASE_URL + token studio
pnpm --filter @athlya/api run k6:book-class
```

Objectif issue #119 : **p99 < 500 ms** @ 100 rps / 60 s. Archiver les chiffres avant/après dans le ticket ou `docs/perf/`.

---

## Rollback

1. Commenter les blocs `[[env.*.hyperdrive]]` dans `wrangler.toml`
2. `wrangler deploy --env <env>`
3. Write path retombe sur `DB_URL` direct (per-request TCP) — latence dégradée mais fonctionnel

---

## Checklist ops

- [ ] Config Hyperdrive staging créée (EU)
- [ ] Config Hyperdrive production créée (EU)
- [ ] `wrangler.toml` IDs renseignés (non commentés)
- [ ] Deploy staging + `/health/ready` hyperdrive OK
- [ ] Deploy production + `/health/ready` hyperdrive OK
- [ ] k6 book-class staging p99 < 500 ms
- [ ] `docs/ACTION-ITEMS.md` P2 Hyperdrive coché

---

## Références

- `packages/api/src/adapters/deps-cache.ts` — write cache si Hyperdrive bound
- `packages/api/src/adapters/postgres-write-url.ts`
- `packages/api/src/worker.ts` — probe Hyperdrive readiness
- Issue #119, audit A2/P2/P3
