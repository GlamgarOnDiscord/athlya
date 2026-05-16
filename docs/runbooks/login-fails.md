# Runbook — Login Fails

Troubleshooting des échecs de login côté API `/v1/auth/login` et côté web `/login`.

## Symptôme : 500 "Cannot perform I/O on behalf of a different request"

**Cause** : cache de connexion DB au niveau module (partagé entre requêtes Workers). Workers isole l'I/O par requête.

**Fix** : voir **Vague 6** dans `docs/modifications/modifications.md`. La fabrique DB doit être créée par requête (jamais mémorisée au scope module). Corrigé.

## Symptôme : 403 Turnstile `timeout-or-duplicate`

**Cause** : le widget Turnstile n'est pas reset après une soumission, le même token est renvoyé deux fois.

**Fix** : voir **Vague 7**. Appeler `turnstile.reset()` après chaque tentative (succès ou échec) et avant de permettre une nouvelle soumission.

## Symptôme : 403 Turnstile `invalid-input-response`

**Cause** : React conserve l'ancien state du token Turnstile entre les renders, ce qui peut envoyer un token déjà consommé ou vide.

**Fix** : voir **Vague 9**. Capturer le token dans une **const locale** au moment du submit, puis **clear** le state avant le `fetch`. Ne jamais lire le state pendant le `fetch`.

```ts
const token = turnstileToken; // capture
setTurnstileToken(null);      // clear avant fetch
await fetch("/v1/auth/login", { /* envoyer `token` */ });
```

## Symptôme : 401 `invalid_credentials`

**Cause** : mot de passe ne match pas le hash stocké (ou mauvais email).

**Diagnostic** :

```powershell
node packages/db/scripts/check-password.mjs <email> <password>
```

**Fix** (forcer un nouveau mot de passe) :

```powershell
node packages/db/scripts/reset-password.mjs <email> <new-password>
```

Attention : le nouveau mot de passe passe par la check HIBP, donc utiliser une valeur non-compromise.

## Symptôme : 500 `connection terminated` sur `/v1/auth/login`

**Cause** : Neon free-tier suspend les computes après ~5 min d'inactivité. La première requête après wake-up peut couper.

**Fix** : simplement retry. `withConnectionRetry` gère ça automatiquement — si le retry échoue encore, vérifier le dashboard Neon (compute up ?).

## Symptôme : 422 `password_breached`

**Cause** : le mot de passe a matché la base HIBP (Have I Been Pwned, k-anonymity).

**Fix** : utiliser un autre mot de passe, non-présent dans les fuites connues. C'est un comportement attendu, pas un bug.

## Quick checks avant d'ouvrir un ticket

- API joignable ? `curl http://localhost:8787/v1/health`
- Vars présentes dans `packages/api/.dev.vars` ?
- Neon compute actif (dashboard) ?
- Turnstile site key / secret appairés (dev vs prod) ?
- Logs API (`wrangler dev` output) pour l'erreur exacte
