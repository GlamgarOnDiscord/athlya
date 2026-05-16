# Athlya — Performance runbook

Ce runbook documente les décisions de performance prises au niveau gateway et persistance pour la stack Athlya.

## 1. Compression HTTP — déléguée à Cloudflare (B5.3)

### Décision

**Le middleware Hono `compress()` n'est PAS mounté.** La compression est entièrement déléguée à Cloudflare Workers.

### Justification

Cloudflare Workers négocie automatiquement la compression de la réponse en fonction de l'`Accept-Encoding` du client :

- `br` (Brotli) si le client le supporte — ratio supérieur sur les payloads JSON.
- `gzip` en fallback pour les clients legacy.
- pas de compression pour les payloads < 256 octets (ratio négatif sous ce seuil).

L'edge applique la compression **après** que le Worker a renvoyé la réponse. Mounter `hono/compress()` à l'intérieur du Worker provoquerait :

1. **Double-compression** : le middleware Hono emit déjà du `content-encoding: gzip` ; Cloudflare ne re-compresse pas mais consomme du CPU pour rien (chaque requête paie le coût gzip dans l'isolate).
2. **Perte du Brotli** : `hono/compress()` ne supporte que gzip / deflate au moment de l'écriture (Hono v4). Brotli (~20 % meilleur ratio) ne serait jamais négocié.
3. **CPU-time du Worker** : le quota de durée d'isolate est limité (50 ms wall-clock par requête sur le bundle Free, 30 s sur Bundled). Faire la compression à l'intérieur ronge ce budget pour rien quand l'edge est gratuit.

### Vérification

Pour confirmer que Cloudflare compresse en prod :

```bash
curl -sI https://api.athlya.app/v1/classes \
  -H 'authorization: Bearer <token>' \
  -H 'accept-encoding: br, gzip' \
  | grep -i 'content-encoding'
```

Doit renvoyer `content-encoding: br` (ou `gzip` selon le client). Si la ligne est absente, vérifier dans la dashboard Cloudflare que **Speed → Optimization → Brotli** est activé.

### En dev local (Wrangler / Miniflare)

Wrangler n'applique pas la même négociation automatique que l'edge. Les réponses servies par `pnpm --filter @athlya/api dev` sortent **non compressées**, ce qui est attendu et n'a pas d'impact sur les tests (ils valident le shape JSON et les headers ETag, pas le `content-encoding`).

## 2. Cache HTTP — ETag + Cache-Control (B5.1, B5.2)

| Endpoint | `Cache-Control` | ETag fingerprint | Justification du TTL |
|----------|-----------------|------------------|----------------------|
| `GET /v1/classes` | `private, max-age=10, must-revalidate` | `(id, version, remaining, startsAt)` joint par `\|` | Le compteur Redis `remaining` change quand un membre book/cancelle, mais 10 s de stale est tolérable côté UI (le book ré-incrémente / décompte côté serveur via une transaction PG, pas via le ETag). |
| `GET /v1/reservations/me` | `private, max-age=5, must-revalidate` | `(id, status, cancelledAt, checkedInAt)` | Le statut peut basculer en temps réel (cancellation utilisateur, promotion FIFO depuis la waitlist). 5 s pinne une fenêtre stale courte sans casser l'observabilité. |

### Mécanique

Les deux handlers calculent un strong ETag SHA-256 (16 hex chars, `"…"`) sur un fingerprint déterministe des items retournés. Si le client envoie `If-None-Match` égal à l'ETag fraîchement calculé, le handler renvoie un `304 Not Modified` vide en réutilisant les mêmes headers `etag` / `cache-control` / `vary: authorization`.

Le `Vary: authorization` empêche tout intermédiaire mutualisé (proxy, CDN, browser shared cache) de servir la réponse d'un utilisateur à un autre.

### Implémentation partagée

Helper : `packages/api/src/routes/helpers.ts → computeListEtag(fingerprint)` — accessible aux deux routes via une seule importation. Tests : `packages/api/src/__tests__/routes/helpers-etag.test.ts` (déterminisme, sensibilité, format wire) + `packages/api/src/__tests__/integration/etag-cache.integration.test.ts` (5 scénarios end-to-end).

## 3. Indexes Postgres — audit (B5.4)

L'audit complet est dans [`docs/perf/indexes-audit.md`](../perf/indexes-audit.md). Synthèse :

- Tous les patterns de requête courants (listing classes par studio + range, listing réservations par user, lookup `class_id + user_id` pour idempotency) sont **déjà couverts** par des indexes existants (composites quand nécessaire, partiels là où pertinent).
- Aucune migration `0005_perf_indexes.sql` n'a été créée — pas de gap critique détecté.
- Les requêtes admin dépendantes de l'audit log (`audit_log` par `actor_id` + `created_at` desc) seront indexées dans la slice B7 quand l'observabilité OTel surfacera les top-N queries réelles.

## 4. N+1 — audit (B5.5)

Audit complet dans [`docs/perf/n-plus-1-audit.md`](../perf/n-plus-1-audit.md). Synthèse :

- `listClasses` : 1 SQL pour les rows + N reads Redis pipelinés en `Promise.all` → pas un N+1 (Redis pipelining). OK.
- `listMyReservations` : 1 SQL JOIN unique. OK.
- `listMembersByStudio` : 1 SQL avec pagination cursor. OK.

Aucune optimisation de requête nécessaire. Si une nouvelle slice introduit un N+1 (par exemple, "lister les classes d'un coach avec leur nombre de réservations confirmed"), elle devra utiliser un agrégat SQL (`COUNT(*) GROUP BY class_id`) plutôt qu'un fan-out par row.

## 5. Slice B5 — récap

| Sous-tâche | Statut | Référence |
|------------|--------|-----------|
| B5.1 — ETag + Cache-Control sur GET /v1/classes | ✅ | section 2 |
| B5.2 — ETag sur GET /v1/reservations/me | ✅ | section 2 |
| B5.3 — Compression | ✅ déléguée à Cloudflare | section 1 |
| B5.4 — Audit indexes | ✅ documenté | section 3 |
| B5.5 — N+1 audit | ✅ documenté | section 4 |
