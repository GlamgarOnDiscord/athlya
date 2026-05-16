# Runbook — JWT key rotation

**Sprint 12 / Slice 12.7 (Epic B3.1, Req 25.5)**

Procedure pour faire pivoter la clef de signature JWT RS256 du gateway
Athlya. À exécuter cycliquement (recommandation : tous les 90 jours)
ou en urgence si un compromise est suspecté.

## Pré-requis

- Compte Cloudflare avec accès `wrangler` au Worker `@athlya/api`.
- JWT admin valide (claim `role: admin`) sur la cible (staging ou
  production).
- Accès en lecture/écriture aux secrets Cloudflare via
  `wrangler secret put` / `wrangler secret delete`.
- ~10 minutes en staging, ~20 minutes en production (avec smoke
  tests entre étapes).

## Vue d'ensemble

L'API `POST /v1/admin/jwt/rotate-prepare` génère une nouvelle paire
de clefs RS256, calcule le JWKS qui combine la clef incoming
("current") et la clef sortante ("previous") pour la durée du grace
window, et retourne tous les artefacts à l'opérateur. **Cet endpoint
ne mute aucun binding live** — l'opérateur exécute manuellement les
`wrangler secret put` qui suivent.

Le grace window (24h par défaut) garantit qu'aucun token déjà émis
ne devient soudain invalide. Les vérificateurs (gateway lui-même +
clients tiers le cas échéant) servent les deux clefs pendant cette
fenêtre, puis on supprime l'ancienne.

## Procédure standard (rotation planifiée)

### Phase 1 — État courant (preflight)

```bash
# Vérifier que la prod tourne avec une JWKS cohérente.
TOKEN=$(athlya-cli auth login --as admin@[à-configurer])
curl -s https://api.athlya.app/v1/admin/jwt/state \
  -H "authorization: Bearer $TOKEN" | jq
```

Le body doit montrer :

- `currentKid` non vide (= la clef que les tokens portent)
- `jwks.keys[]` avec exactement 1 entrée (rotation précédente
  nettoyée)

Si `jwks.keys[]` a déjà 2 entrées, une rotation antérieure n'a pas
été nettoyée — terminer phase 5 ci-dessous avant de continuer.

### Phase 2 — Préparer la rotation

```bash
curl -s -X POST https://api.athlya.app/v1/admin/jwt/rotate-prepare \
  -H "authorization: Bearer $TOKEN" \
  -o rotation.json
```

Le fichier `rotation.json` contient :

```jsonc
{
  "currentKid": "athlya-XXXX-YYYY",
  "currentPrivatePem": "-----BEGIN PRIVATE KEY-----\n...",
  "currentPublicPem": "-----BEGIN PUBLIC KEY-----\n...",
  "previousKid": "athlya-OLD",
  "previousNotAfter": "2025-XX-XXTXX:XX:XX.XXXZ",
  "graceSec": 86400,
  "jwks": {
    "keys": [
      {
        "kty": "RSA",
        "kid": "athlya-XXXX-YYYY",
        "n": "...",
        "e": "AQAB",
        "alg": "RS256",
        "use": "sig",
      },
      { "kty": "RSA", "kid": "athlya-OLD", "n": "...", "e": "AQAB", "alg": "RS256", "use": "sig" },
    ],
  },
}
```

> ⚠️ **Sécurité** : `currentPrivatePem` est secret. Ne pas committer
> `rotation.json`. Le supprimer dès que les `wrangler secret put`
> ci-dessous sont passés.

### Phase 3 — Persister la clef sortante comme "previous"

L'ancienne clef doit rester accessible jusqu'à `previousNotAfter`
pour que les tokens déjà émis continuent à vérifier. On la backup
sous des noms `*_PREVIOUS` avant d'overwrite la slot principale.

```bash
# Lire les valeurs actuelles depuis Cloudflare (tu dois les avoir
# stockées localement après la dernière rotation, ou les re-extraire
# du `wrangler secret get` si dispo dans ton plan).
PREV_KID=$(wrangler secret list --env production | jq -r '.[] | select(.name=="JWT_KID") | .value')
# (variantes selon plan Cloudflare ; en pratique, tu gardes une
# copie sécurisée hors-Cloudflare des PEM lors de chaque rotation.)

wrangler secret put JWT_KID_PREVIOUS --env production
# (paste l'ancien kid)

wrangler secret put JWT_PRIVATE_KEY_PEM_PREVIOUS --env production
# (paste l'ancien private PEM)

wrangler secret put JWT_PUBLIC_KEY_PEM_PREVIOUS --env production
# (paste l'ancien public PEM)
```

### Phase 4 — Push des nouveaux secrets

```bash
# Nouvelle clef "current".
echo $(jq -r '.currentKid' rotation.json) | wrangler secret put JWT_KID --env production
jq -r '.currentPrivatePem' rotation.json | wrangler secret put JWT_PRIVATE_KEY_PEM --env production
jq -r '.currentPublicPem' rotation.json | wrangler secret put JWT_PUBLIC_KEY_PEM --env production

# Nouveau JWKS — contient les deux clefs pendant le grace window.
jq -c '.jwks' rotation.json | wrangler secret put JWKS_JSON --env production
```

### Phase 5 — Redéployer + smoke test

```bash
wrangler deploy --env production

# Smoke : un nouveau login doit produire un token signé avec le
# nouveau kid.
NEW_TOKEN=$(athlya-cli auth login --as smoke-user@athlya.app)
echo $NEW_TOKEN | cut -d. -f1 | base64 -d 2>/dev/null | jq .kid
# Doit afficher le `currentKid` de rotation.json.

# Smoke : un token émis AVANT la rotation doit toujours vérifier
# pendant le grace window.
curl -s https://api.athlya.app/v1/me \
  -H "authorization: Bearer $OLD_TOKEN" | jq
# Doit retourner 200, pas 401.

# Vérifier que JWKS expose bien les deux kids.
curl -s https://api.athlya.app/.well-known/jwks.json | jq '.keys[].kid'
```

### Phase 6 — Cleanup (après le grace window)

À exécuter `previousNotAfter + 1h` ou plus tard. Surveiller les
métriques `auth.invalid_token` ; quand elle est tombée à zéro, le
grace window est purgé.

```bash
wrangler secret delete JWT_KID_PREVIOUS --env production
wrangler secret delete JWT_PRIVATE_KEY_PEM_PREVIOUS --env production
wrangler secret delete JWT_PUBLIC_KEY_PEM_PREVIOUS --env production

# Pousser un JWKS qui ne contient QUE la clef current.
NEW_JWKS=$(jq -c '{keys:[.jwks.keys[] | select(.kid != .previousKid)]}' rotation.json)
echo "$NEW_JWKS" | wrangler secret put JWKS_JSON --env production

wrangler deploy --env production
```

## Procédure d'urgence (compromise suspecté)

Skip le grace window — on accepte de logger out tous les utilisateurs
plutôt que de risquer de continuer à accepter une clef compromise.

1. Faire phases 1 + 2 + 3 + 4 ci-dessus.
2. Phase 5 modifiée : pousser un JWKS qui ne contient QUE la
   nouvelle clef (pas le grace window).
   ```bash
   jq -c '{keys:[.jwks.keys[] | select(.kid == .currentKid)]}' rotation.json \
     | wrangler secret put JWKS_JSON --env production
   ```
3. Redéployer.
4. Tous les tokens émis avant la rotation deviennent invalides
   immédiatement → utilisateurs forcés à se reloguer.
5. Audit log : marquer l'incident dans `incident_log` table avec
   `action: 'jwt_emergency_rotation'`.

## Audit trail

Chaque appel `POST /v1/admin/jwt/rotate-prepare` écrit une ligne
dans `audit_log` :

```sql
SELECT actor_id, action, metadata, created_at
FROM audit_log
WHERE action = 'jwt.key.rotation_prep'
ORDER BY created_at DESC;
```

`metadata` contient `{ kidOld, kidNew, graceSec }`. PII-safe : pas
d'IP, pas d'UA, pas d'email. La traçabilité passe par `actor_id` →
`users.email` joint si besoin.

## Tests automatisés associés

- `packages/api/src/__tests__/jwt-rotate-routes.test.ts` — 9 tests
  unit/integration couvrant tous les paths (403/500/200, audit hook
  succès et échec, JWKS dual-key shape).
- `packages/auth/src/__tests__/jwt.test.ts` — tests de la primitive
  `rotateKeysAsync` qui sous-tend l'endpoint.

## Références

- RFC 7517 — JSON Web Key (Set)
- Requirement 25.5 — Key rotation policy
- `packages/auth/src/jwt.ts` — `rotateKeys` / `rotateKeysAsync`
- `packages/api/src/admin/jwt-rotate-routes.ts` — implementation
