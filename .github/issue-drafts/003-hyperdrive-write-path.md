## Résumé

Le hot path booking/cancel crée un client **postgres-js TCP neuf par requête** (`makeWriteDb()` dans `reservations-deps.ts`, `maxConnections: 1`, non cacheable cross-request Cloudflare Workers). **Hyperdrive n'est pas câblé** dans `wrangler.toml` malgré mentions dans `project.md` et `docs/STACK-AUDIT.md`.

## Comportement attendu

- Latence booking p99 < 500ms (SLO S1)
- Pool connexions Neon stable sous 100 req/s (k6 profile)

## Comportement observé

Chaque `POST /v1/reservations` :

1. TLS handshake Neon (~50–500ms cold start)
2. Transaction interactive
3. Socket fermé (`idleTimeoutSec: 5`)

À charge : saturation connexions Neon + violation SLO.

## Impact

- **Sévérité** : Critical / P0 perf
- SLO p99 < 500ms **non tenable** sans Hyperdrive en prod réelle
- Risque `too many connections` dès pic studio (sortie de cours)

## Solution proposée

### Phase 1 — Hyperdrive binding

1. Dashboard Cloudflare → Hyperdrive → config Neon EU (`aws-eu-central-1`)
2. `wrangler.toml` :

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<config-id>"

# Répéter par env staging/production
```

3. `packages/api/src/types.ts` — ajouter `HYPERDRIVE?: Hyperdrive` à `AthlyaBindings`
4. `packages/db/src/client.ts` — `createDb(env.HYPERDRIVE?.connectionString ?? env.DB_URL, { max: 3 })`

### Phase 2 — Validation

- k6 `book-class.js` contre staging **avec secrets provisionnés**
- Comparer p50/p99 avant/après dans artifact CI
- Documenter dans `docs/frameworks/postgres-js.md`

### Phase 3 — Fallback

Health `/health/ready` inclure latence Hyperdrive vs direct.

## Composants touchés

- [x] `packages/api/wrangler.toml`
- [x] `packages/db/src/client.ts`
- [x] `packages/api/src/adapters/reservations-deps.ts`
- [x] `docs/runbooks/` + `docs/ACTION-ITEMS.md` (fermer P2 Hyperdrive)

## Critères d'acceptation

- [ ] Hyperdrive provisionné staging + production
- [ ] k6 p99 < 500ms sur staging (60s @ 100 rps)
- [ ] Pas de régression tests intégration
- [ ] Runbook deploy production Phase 2 mis à jour

## Références

- `docs/frameworks/cloudflare-workers.md` — Missing Hyperdrive section
- `docs/ACTION-ITEMS.md` P2
- Audit infra 2026-05-27 — finding #3 Critical

## Priorité

**P0** — bloquant perf prod + scalabilité
