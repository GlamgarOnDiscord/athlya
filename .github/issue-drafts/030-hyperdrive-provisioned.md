## Résumé

Le code supporte Hyperdrive (`deps-cache.ts`, commentaires `wrangler.toml`) mais les bindings **`[[hyperdrive]]` restent commentés**. `getOrCreateWriteDb()` sans Hyperdrive crée un client postgres-js TCP **`maxConnections: 1` par appel book/cancel**.

**Finding audit** : A2 / P2 / P3 — gravité **Critical**, priorité **P0**.

Issue #62 fermée avec code/tests — **provisionnement dashboard CF non fait**.

## Comportement attendu

- Hyperdrive EU provisionné staging + production
- Write path booking/cancel via `env.HYPERDRIVE.connectionString`
- SLO p99 booking < 500ms tenable à 50+ RPS sur même classe
- `/health/ready` expose latence Hyperdrive vs fallback

## Comportement observé

```toml
# packages/api/wrangler.toml L355-357, L420-422
# [[env.staging.hyperdrive]]
# binding = "HYPERDRIVE"
# id = "<staging-hyperdrive-config-id>"
```

Chaque booking :

1. TLS handshake Neon (~50–500ms cold)
2. Transaction interactive
3. Socket fermé

## Impact production

- p99 booking **>> 500 ms** sous charge réelle
- Saturation connexions Neon (`too many connections`) aux pics (sortie de cours)
- SLO documenté **non tenable** — premier studio réel = timeouts visibles

## Solution proposée

### Phase 1 — Dashboard Cloudflare

1. Hyperdrive → Create config → Neon EU (`aws-eu-central-1`)
2. Copier config IDs staging + production

### Phase 2 — wrangler.toml

Décommenter et remplir :

```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "<staging-id>"

[[env.production.hyperdrive]]
binding = "HYPERDRIVE"
id = "<production-id>"
```

### Phase 3 — Validation charge

- k6 `book-class.js` contre staging avec secrets provisionnés
- Comparer p50/p99 avant/après (artifact CI ou doc résultats)
- Vérifier `packages/api/src/adapters/deps-cache.ts` utilise bien Hyperdrive

### Phase 4 — Fallback documenté

Si Hyperdrive indisponible : alerte + degrade graceful (pas silent fallback owner TCP).

## Composants touchés

- [ ] Cloudflare Dashboard Hyperdrive
- [ ] `packages/api/wrangler.toml`
- [ ] `docs/runbooks/deploy-production.md` Phase 2
- [ ] `docs/ACTION-ITEMS.md` — fermer item Hyperdrive ops

## Critères d'acceptation

- [ ] Hyperdrive actif staging + production (binding non commenté)
- [ ] k6 staging p99 < 500ms @ 100 rps / 60s
- [ ] `/health/ready` inclut check Hyperdrive
- [ ] Pas de régression tests intégration booking
- [ ] Runbook deploy mis à jour avec IDs config

## Références

- `packages/api/src/adapters/deps-cache.ts` L119-120
- `.github/issue-drafts/003-hyperdrive-write-path.md`
- Issue fermée #62 (code) vs ops provisioning
- Audit prod 2026-05-27 — A2, P2, P3

## Priorité

**P0** — bloquant perf + stabilité avant pic horaire studio
