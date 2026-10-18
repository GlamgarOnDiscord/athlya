# GrowthBook setup (optional)

**Sprint 14 / Slice 14.9 (Epic CN.4.1)**

Procédure pour migrer du provider statique JSON
(`feature-flags.ts#buildStaticFeatureFlagProvider`) vers GrowthBook
quand le catalogue dépasse ~10 flags ou que les rollout-by-attributes
deviennent complexes.

## Quand migrer ?

Critères :

- ≥ 10 flags actifs
- Besoin de rollout par attribute (plan abonnement, device type,
  geo) — le provider statique ne le supporte que via
  `userAllowList`/`studioAllowList`
- Besoin d'un dashboard non-tech (Product / CSM peut toggle un
  flag sans déploiement)
- Besoin d'A/B testing avec analyse statistique

Avant ces seuils, **rester sur le provider statique** est plus
simple, moins de dépendance externe, ZERO cost.

## Option A — GrowthBook Cloud (free tier)

### 1. Créer le compte

<https://www.growthbook.io/> → free tier inclut :

- 5 environments
- 100 flags
- 1k MAU sur l'évaluation client-side
- Membres illimités

### 2. Créer un environnement par stage

- `dev` — connecté à `wrangler dev`
- `staging` — connecté au staging Cloudflare Workers
- `production` — la cible finale

### 3. Provisionner l'API key

GrowthBook UI → Settings → Environments → Production → Generate
SDK Endpoint Key.

```bash
wrangler secret put GROWTHBOOK_CLIENT_KEY --env production
# > sdk-XXXX-YYYY
```

## Option B — GrowthBook self-hosted

Pour les studios qui ne veulent pas envoyer leur usage data à un
tiers (RGPD strict), on peut self-host GrowthBook sur Cloudflare
Workers + R2 :

```bash
# Out of scope — le déploiement self-hosted demande son propre
# guide. La doc officielle est sur
# https://docs.growthbook.io/self-host
```

## Adapter `@athlya/api`

Créer `packages/api/src/adapters/feature-flags-growthbook.ts` qui
implémente `FeatureFlagProvider` :

```ts
import type { FeatureFlagProvider, FeatureFlagContext } from '../feature-flags.js';

export function createGrowthBookProvider(
  clientKey: string,
  apiHost: string = 'https://api.growthbook.io',
): FeatureFlagProvider {
  // Cache du payload features GrowthBook — TTL 60s aligné avec
  // notre cache wrapper.
  let cache: { features: Record<string, unknown>; expiresAt: number } | null = null;

  async function loadFeatures() {
    if (cache !== null && cache.expiresAt > Date.now()) {
      return cache.features;
    }
    const res = await fetch(`${apiHost}/api/features/${clientKey}`);
    if (!res.ok) {
      // Fail-OPEN aligné avec les autres défenses
      return cache?.features ?? {};
    }
    const body = (await res.json()) as { features: Record<string, unknown> };
    cache = {
      features: body.features,
      expiresAt: Date.now() + 60_000,
    };
    return body.features;
  }

  return {
    async getFlag(name: string, ctx: FeatureFlagContext): Promise<boolean> {
      const features = await loadFeatures();
      const def = features[name] as { defaultValue?: boolean; rules?: unknown[] } | undefined;
      if (def === undefined) return false;

      // GrowthBook eval: matchers contre les attributes ctx.
      // L'eval natif est dans le SDK officiel — pour rester
      // léger on n'inclut ici que la branche defaultValue.
      // Le SDK complet (`@growthbook/growthbook` 1.x, ~30KB
      // gzipped) supporte les rules conditions, splits A/B,
      // etc.
      return def.defaultValue ?? false;
    },
  };
}
```

Wirer dans `auth-deps.ts` :

```ts
import { createGrowthBookProvider } from './feature-flags-growthbook.js';
import { isEnabled } from '../feature-flags.js';

const flagProvider = (env as { GROWTHBOOK_CLIENT_KEY?: string }).GROWTHBOOK_CLIENT_KEY
  ? createGrowthBookProvider(env.GROWTHBOOK_CLIENT_KEY)
  : buildStaticFeatureFlagProvider(env.FEATURE_FLAGS_JSON);

// Usage:
const showCoachAI = await isEnabled(
  'ai-coach',
  { userId: claims.userId, studioId: claims.studioId },
  flagProvider,
);
```

## Migration progressive

1. **Phase A — Mirror** : exposer LES MÊMES flags sur les deux
   providers. Comparer les évaluations (logger + alerter sur
   divergence) pendant 2 semaines.
2. **Phase B — Switch** : passer la production sur GrowthBook,
   garder le static comme fallback (`if GROWTHBOOK_CLIENT_KEY
missing, fall back`).
3. **Phase C — Decom** : retirer le provider static + le binding
   `FEATURE_FLAGS_JSON`.

## SDK complet

Pour A/B testing + rules avancées, installer le SDK officiel :

```bash
pnpm --filter @athlya/api add @growthbook/growthbook
```

Et adapter le provider pour utiliser `GrowthBook.evalFeature()`
qui supporte tout le rules engine. Out of scope Sprint 14.

## Provisioning checklist

| Item                                  | Status | Owner                                  |
| ------------------------------------- | ------ | -------------------------------------- |
| Compte GrowthBook free tier           | ⏳     | DevOps                                 |
| Environnements dev/staging/prod       | ⏳     | DevOps                                 |
| Secret `GROWTHBOOK_CLIENT_KEY`        | ⏳     | DevOps                                 |
| Adapter `feature-flags-growthbook.ts` | ⏳     | Eng (à coder quand le compte est prêt) |
| Migration des 3 flags pilotes         | ⏳     | Eng                                    |
| Decom `FEATURE_FLAGS_JSON`            | ⏳     | Eng (post-migration)                   |

## Références

- `packages/api/src/feature-flags.ts` — wrapper + cache
- `docs/operations/feature-flags.md` — playbook rollout
- GrowthBook docs: <https://docs.growthbook.io/>
