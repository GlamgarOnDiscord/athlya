# Audit middleware idempotency

**Sprint 12 / Slice 12.6 (Epic B4.1)**

Audit du middleware `packages/api/src/middleware/idempotency.ts` + store
`packages/db/src/idempotency.ts`. Ce document liste l'état actuel, les
écarts par rapport au pattern Stripe canonique, et les recommandations
slice future.

## État actuel

### Architecture

- Middleware Hono mounté sur les routes mutation (POST /v1/reservations
  par exemple via `buildReservationsRouter`).
- Store backé par Postgres via `@athlya/db/idempotency` :
  - Table `idempotency_keys (key, user_id, response, status_code, expires_at)`
  - PK composite `(key, user_id)` → first-writer-wins via `INSERT … ON
    CONFLICT DO NOTHING`.
- Lookup → store dans la même request lifecycle.

### Caractéristiques

| Aspect | État | Conformité Stripe |
|---|---|---|
| TTL Redis/Postgres | 24h (`DEFAULT_IDEMPOTENCY_TTL_SEC`) | ✅ identique |
| Clé scope | `(key, user_id)` | ✅ identique |
| Statuts cachés | 2xx + 409 (Stripe inclut 4xx aussi) | ⚠️ diff intentionnel |
| Hash body | Non | ❌ écart |
| Set-Cookie dans le replay | Non écrit (body JSON only) | ✅ OK |
| Locking concurrent | First-writer-wins via ON CONFLICT | ✅ OK |
| Failure mode | Lookup fail → continue (degrade) | ⚠️ risque double-exec |

## Findings

### B4.1.1 — Hash body absent (MEDIUM)

**Risque** : un client malveillant qui réutilise un `Idempotency-Key`
avec un body différent reçoit la cached response du premier call. Il
pense que sa modification est appliquée mais c'est l'ancienne réponse.

Pattern Stripe : on hash le body (SHA-256) à la première écriture, et
toute requête ultérieure avec le même `Idempotency-Key` mais un body
hash différent renvoie 422 `idempotency_key_in_use_with_different_body`.

**Mitigation actuelle** : le scope `(key, user_id)` limite l'attaque à
un attaquant qui a déjà compromis le compte de la victime. Dans ce
cas, l'attaquant a déjà des moyens plus directs.

**Effort** : ~2h. Migration `0007_idempotency_request_hash.sql` qui
ajoute `request_hash text` + populate sur tous les rows existants en
NULL. Middleware modifié pour calculer SHA-256 du body avant
`store()`. Lookup compare le hash et retourne 422 sur mismatch.

### B4.1.2 — Lookup fail-degrade vs fail-close (LOW)

**Risque** : si le DB Neon hoquette pendant le lookup, on continue à
exécuter la mutation. Sur un retry du client, le lookup regarderait
réussit, mais le store ON CONFLICT a déjà persisté la première
réponse → le 2e call recrée la réservation (double-booking).

**Mitigation actuelle** : `INSERT … ON CONFLICT DO NOTHING` au store
empêche la 2e ligne de remplacer la première — mais la mutation a
quand même été exécutée 2x au niveau métier (deux INSERT
reservations). Le `unique_violation` au niveau métier (réservation par
class+user) doit absorber le doublon.

**Effort** : ~30min. Switch sur fail-CLOSED : si lookup throw, retourner
500 `idempotency_lookup_failed` immédiatement. Test unit pour le path.

### B4.1.3 — Statuts cachés (INFO)

Le middleware ne cache que `2xx` + `409`. Stripe cache aussi 4xx (toute
réponse "déterministe"). Pour Athlya, cacher 4xx pose problème : un
422 sur validation pourrait être caché alors que le client est en
train de corriger sa requête entre 2 retries.

**Décision** : statu quo. Le diff vs Stripe est intentionnel.

### B4.1.4 — `Set-Cookie` dans le replay (PASS)

Le store cache `{ body, statusCode }` uniquement. Aucun header n'est
re-émis sur le replay. Le risque "fuite de cookie d'une session vers
une autre" n'existe pas dans cette implémentation.

### B4.1.5 — Body JSON uniquement (INFO)

`readJsonBody()` lit le body en JSON. Si la réponse de l'endpoint est
binaire (ex: PDF d'export), le replay ne fonctionne pas. Comme tous
nos endpoints mutationnels renvoient JSON, c'est acceptable.

## Recommandations

### Immédiat (slice 12.6 = audit only, pas de code)

- ✅ Document publié.
- ✅ Findings B4.1.1, B4.1.2 entrés au backlog.
- ✅ Coche B4.1 audit dans tasks.md (audit livré, fixes en backlog).

### Slice future (~2.5h cumulés)

1. **B4.1.1 fix — body hash** : migration SQL + middleware update.
2. **B4.1.2 fix — fail-close** : switch path + test unit.

## Tests existants

- `packages/api/src/__tests__/idempotency.test.ts` — 13 tests verts
  couvrant : key validation (longueur, non-empty), userId obligatoire,
  lookup hit/miss, store on success, ON CONFLICT first-writer-wins,
  graceful degradation lookup failure, body JSON parse failure, TTL
  override.

## Conclusion

Le middleware idempotency Athlya satisfait Req 20.1 + 20.2. L'écart
principal vs Stripe (body hash absent) est un finding MEDIUM
mitigeable et tracé en backlog. Pas de risque CRITICAL ni HIGH dans
l'implémentation courante.
