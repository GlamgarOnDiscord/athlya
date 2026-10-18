# Feature flags playbook — Athlya

**Sprint 14 / Slice 14.4 (Epic CN.4.4)**

Procédure de rollout progressif pour activer une nouvelle feature
sans risquer un blast-radius global. Pattern Stripe / GitHub /
Cloudflare ops.

## Architecture

- **Wrapper** : `packages/api/src/feature-flags.ts`
  - `isEnabled(name, ctx, provider)` avec cache 60s per-isolate
  - Rollout bucketing déterministe par `userId` (djb2 hash mod 100)
  - `allowList` + `studioAllowList` pour opt-in early adopters

- **Provider statique par défaut** : lit
  `env.FEATURE_FLAGS_JSON` (Wrangler secret JSON-stringifié). Suffit
  pour les phases initiales.

- **Provider externe** (slice future) : adapter GrowthBook / Unleash
  / LaunchDarkly. Le wrapper accepte n'importe quel provider via
  l'interface `FeatureFlagProvider`.

## Format catalogue JSON

```json
{
  "ai-coach": false,
  "waitlist-auto-promotion-v2": {
    "rollout": 10,
    "studioAllowList": ["22222222-2222-4222-8222-222222222222"]
  },
  "new-billing-flow": {
    "rollout": 0,
    "allowList": ["user-internal-1", "user-internal-2"]
  }
}
```

## Procédure standard de rollout

### Phase 0 — Internal testing (jour 0)

```jsonc
{
  "your-flag": {
    "rollout": 0,
    "allowList": ["user-id-tom", "user-id-eng-team-1", "user-id-eng-team-2"],
  },
}
```

- Flag activé UNIQUEMENT pour l'équipe interne
- Push via `wrangler secret put FEATURE_FLAGS_JSON --env staging`
- Test E2E sur staging avec un compte de l'allowList
- Critère pour passer en Phase 1 : pas de bug bloquant + métriques
  Axiom équivalentes au baseline (no error spike)

### Phase 1 — Early adopters (jour 1)

```jsonc
{
  "your-flag": {
    "rollout": 1,
    "allowList": ["user-id-tom", "user-id-eng-team-1", "user-id-eng-team-2"],
  },
}
```

- 1% des utilisateurs voient la feature
- **Surveiller pendant 24-48h** :
  - Error rate de la feature (Axiom : group by `feature.name` si on
    stamp un span attribute)
  - Latency p99 sur les endpoints touchés
  - Logs Sentry pour tout breadcrumb `feature.your-flag.*`
- Critère Phase 2 : error rate de la cohorte rollout = error rate
  baseline ± 0.05%

### Phase 2 — Validation à 10% (jour 2-3)

```jsonc
{ "your-flag": { "rollout": 10, "allowList": [...] } }
```

- 10% des utilisateurs
- **Surveiller pendant 48-72h** :
  - Mêmes métriques que Phase 1
  - - Sentry / Slack pour les anomalies utilisateur (support tickets
      référencent souvent la feature implicitement)
- Critère Phase 3 : pas de régression UX + pas de spike DB/Redis

### Phase 3 — 50% (jour 5-7)

```jsonc
{ "your-flag": { "rollout": 50, "allowList": [...] } }
```

- 50% des utilisateurs — c'est le point où un bug latent serait
  visible mais où on peut encore rollback à <50%
- **Surveiller pendant 5-7 jours**
- Critère Phase 4 : tous les SLOs verts + pas de plainte support
  tracée à la feature

### Phase 4 — 100% (jour 14+)

```jsonc
{ "your-flag": true }
```

- Activation complète (boolean simple)
- Garder le flag dans le code 30j puis nettoyer

## Procédure de rollback

À tout moment d'une phase, si une régression est détectée :

```bash
# 1. Diminuer le rollout immédiatement
wrangler secret put FEATURE_FLAGS_JSON --env production
# > {"your-flag": false}

# 2. Le cache 60s par isolate fait que la propagation prend
#    jusqu'à 60s. Si le bug est critique, hard-restart les
#    Workers via `wrangler deploy` (force toutes les isolates à
#    se recharger).

# 3. Documenter dans incident_log
```

**Ne jamais bypass le cache** par un mécanisme custom — la
prédictibilité du delta de propagation est plus précieuse que les
60s gagnés.

## Catalogue de flags pilotes (Sprint 14)

| Flag                         | Default | Phase actuelle     | Usage                                                                                                                                                                                                                             |
| ---------------------------- | ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-coach`                   | `false` | Phase 0 (internal) | Gate Epic 21 (AI coach, Mistral). OFF : `GET /v1/coach` → `{ enabled: false }`, `POST /v1/coach/ask` → 404, lien web masqué. Câblé dans `adapters/coach-deps.ts` ; requiert `MISTRAL_API_KEY` (sinon 503 `coach_not_configured`). |
| `waitlist-auto-promotion-v2` | `false` | Phase 0 (internal) | Algorithme alternatif pour `cancelReservation` qui promote la waitlist en FIFO + priority badge (vs FIFO simple actuel).                                                                                                          |
| `new-billing-flow`           | `false` | Phase 0 (internal) | Stripe PaymentIntent au lieu de Subscription Checkout. À activer quand on supportera les paiements one-shot.                                                                                                                      |

## Provisioning

Configuration initiale (à faire une fois par environnement) :

```bash
# Staging
echo '{"ai-coach":false,"waitlist-auto-promotion-v2":false,"new-billing-flow":false}' \
  | wrangler secret put FEATURE_FLAGS_JSON --env staging

# Production
echo '{"ai-coach":false,"waitlist-auto-promotion-v2":false,"new-billing-flow":false}' \
  | wrangler secret put FEATURE_FLAGS_JSON --env production
```

## Migration future vers GrowthBook

Quand le catalogue dépasse ~10 flags ou que les rollout-by-attributes
deviennent complexes (ex: par plan abonnement, par device type), on
migre vers GrowthBook :

1. Provisionner GrowthBook self-hosted ou cloud free tier
2. Créer un adapter `packages/api/src/adapters/feature-flags-growthbook.ts`
   implémentant `FeatureFlagProvider`
3. Wirer dans `auth-deps.ts` / `members-deps.ts` selon les call sites
4. Décommissionner `FEATURE_FLAGS_JSON` après validation

## Tests

- `packages/api/src/__tests__/feature-flags.test.ts` — 11 tests
  unitaires couvrant : unknown flag, JSON malformé, boolean,
  allowList, studioAllowList, rollout 0/100/50, déterminisme du
  bucketing, cache 60s, séparation per-user.

## Références

- `packages/api/src/feature-flags.ts` — implémentation
- Stripe Engineering Blog — _Feature flags at Stripe_
- LaunchDarkly Cookbook — _Progressive delivery patterns_
