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
setTurnstileToken(null); // clear avant fetch
await fetch('/v1/auth/login', {/* envoyer `token` */});
```

## Symptôme : app mobile — 403 `bot_challenge_failed` ou vérification de sécurité en échec

L'app native résout Turnstile dans une WebView qui charge `GET /v1/auth/turnstile-challenge` sur le Worker auth (#649, détails dans [`docs/mobile/README.md`](../mobile/README.md#bot-protection-turnstile)).

- **La page répond `500 configuration_error`** : `TURNSTILE_SITE_KEY` absent ou mal formé sur le Worker auth. `wrangler secret put TURNSTILE_SITE_KEY --config wrangler.auth.toml --env <staging|production>` (même site key que l'app web de l'environnement).
- **Le widget affiche l'erreur `110200`** : le hostname de l'API (`api.athlya.app`, `staging.api.athlya.app`) n'est pas dans les hostnames autorisés du widget Turnstile (dashboard Cloudflare → Turnstile → widget → Hostname management).
- **Le widget passe mais l'API répond 403** : site key et `TURNSTILE_SECRET` ne sont pas appairés (clé de test d'un côté, vraie clé de l'autre). Les logs API montrent `turnstile verification rejected` avec `invalid-input-response`.
- **403 après un premier échec** : le token est à usage unique ; l'écran recharge le challenge après chaque tentative. Si ce n'est pas le cas, c'est un bug de l'app.

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
- Turnstile site key / secret appairés (dev vs prod) ? Côté mobile, `TURNSTILE_SITE_KEY` posé sur le Worker auth ?
- Logs API (`wrangler dev` output) pour l'erreur exacte
