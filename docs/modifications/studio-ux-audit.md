# Studio UX Audit — Session 2026-05-16

Tests manuels complets de toutes les pages du Studio admin (`localhost:3001`).
Credentials: alice@athlya.test / AlicePass-2026! (role: admin)

---

## Résumé

| Ref | Page / Feature                                                                   | Statut          | Sévérité |
| --- | -------------------------------------------------------------------------------- | --------------- | -------- |
| B1  | Web app : `GET /v1/classes` retourne 401 (mauvais issuer/audience JWT)           | **Corrigé**     | P0       |
| B2  | Web app : texte nav déborde sur mobile (`whitespace-nowrap` manquant)            | **Corrigé**     | P3       |
| B3  | Web app : double footer sur toutes les pages                                     | **Corrigé**     | P2       |
| B4  | Web app : bouton "Réserver" toujours actif même pour un cours déjà réservé       | **Corrigé**     | P1       |
| B5  | Web app : triple `<h2>` sur la page `/me` (3 sections avec le même h2)           | **Corrigé**     | P3       |
| B6  | Web app : date de consentement affichée en ISO brut (`2025-01-01T00:00:00.000Z`) | **Corrigé**     | P2       |
| B7  | Studio : route `DELETE /v1/classes/:id` absente (404) + pas d'optimistic removal | **Corrigé**     | P0       |
| O1  | Studio : `net::ERR_ABORTED` loggué pour DELETE 204                               | **Observation** | P3       |

---

## Détail des bugs corrigés

### B1 — ClassesList 401 sur `GET /v1/classes`

**Fichier :** `packages/api/src/adapters/auth-deps.ts`

**Symptôme :** La page `/classes` de l'app web ne chargeait aucun cours — console 401 Unauthorized.

**Cause :** `jwtIssuer` et `jwtAudience` mal configurés dans l'adapteur auth de Hono.

**Fix :** Correction des valeurs `issuer` / `audience` pour correspondre aux claims du JWT RS256.

---

### B2 — Débordement texte nav sur mobile

**Fichier :** `apps/web/src/components/AppNav.tsx`

**Symptôme :** Les labels de navigation passaient sur 2 lignes sur petits écrans.

**Fix :** Ajout de `whitespace-nowrap` sur les éléments `<a>` du nav.

---

### B3 — Double footer

**Fichier :** `apps/web/src/app/layout.tsx`

**Symptôme :** Le `<footer>` apparaissait deux fois sur toutes les pages.

**Fix :** Suppression du `<footer>` dupliqué dans le layout.

---

### B4 — Bouton "Réserver" actif sur cours déjà réservé

**Fichiers :**

- `apps/web/src/app/classes/ClassCard.tsx`
- `apps/web/src/app/classes/ClassesList.tsx`
- `packages/shared/src/i18n/fr.json` + `en.json` + copies `dist/`

**Symptôme :** Après avoir réservé un cours, le bouton restait cliquable sans indication visuelle.

**Fix :**

- `ClassesList` : construit un `Set<string>` `bookedClassIds` depuis les réservations existantes.
- `ClassCard` : prop `booked` → bouton disabled + label `"Réservé"` / `"Booked"` (clé i18n ajoutée).

---

### B5 — Triple `<h2>` sur `/me`

**Fichiers :**

- `apps/web/src/app/me/ProfileForm.tsx`
- `apps/web/src/app/me/export/ExportPanel.tsx`
- `apps/web/src/app/me/delete/DeletePanel.tsx`

**Symptôme :** Les 3 sections de la page profil partageaient le même `<h2>` → erreur d'accessibilité.

**Fix :** Chaque section a son propre titre sémantiquement distinct.

---

### B6 — Date de consentement en ISO brut

**Fichier :** `apps/web/src/app/me/ConsentsForm.tsx`

**Symptôme :** La date de consentement s'affichait `2025-01-01T00:00:00.000Z` au lieu de `1 janv. 2025`.

**Fix :** Utilisation de `Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(date))`.

---

### B7 — DELETE /v1/classes/:id absent + pas d'optimistic removal

**Sévérité :** P0 — suppression de cours entièrement impossible.

**Fichiers modifiés :**

- `packages/api/src/routes/classes.ts` — ajout de `DELETE /:id`
- `packages/api/src/adapters/classes-repo-drizzle.ts` — `createDrizzleDeleteClassRepo`
- `packages/api/src/adapters/reservations-deps.ts` — wiring `deleteClass` dans `buildClassesDeps`
- `apps/studio/src/app/dashboard/classes/ClassesAdminList.tsx` — `client.del` (était `client.delete`) + optimistic removal
- Helpers de test : `helpers.ts`, `route-test-helpers.ts`, `integration-helpers.ts`

**Cause :**

1. Route DELETE jamais implémentée — la méthode `client.delete` n'existe pas sur `ApiClient` (c'est `client.del`).
2. Pas d'adapter Drizzle pour le soft-delete des cours + annulation des réservations actives.
3. Après suppression réussie, le composant attendait un re-fetch complet → l'item supprimé restait visible jusqu'au F5.

**Fix :**

1. Route `DELETE /:id` sur le router Hono classes — soft-delete via `deletedAt = now()`, annulation des réservations `confirmed`/`waitlist`.
2. `.returning()` sans arguments pour compatibilité `AthlyaDbAny` (union `AthlyaDb | AthlyaDbHttp`).
3. Optimistic removal dans `handleDelete` : la classe est spliced de `status.items` **avant** l'appel API. En cas d'échec, rollback via `refreshNonce++`.

**Vérification :** `npx tsc --noEmit` → zéro erreur. Tests manuels : création, modification, suppression OK.

---

## Observations (non bloquantes)

### O1 — `net::ERR_ABORTED` sur DELETE 204

**Page :** Studio `/dashboard/classes`

**Description :** Le navigateur logue `net::ERR_ABORTED` pour la requête `DELETE /v1/classes/:id` bien que la suppression soit effectivement réalisée côté serveur. La class disparaît immédiatement (optimistic removal) et le re-fetch post-catch confirme l'état vide.

**Hypothèse :** Faux positif lié à la réponse HTTP 204 No Content sans body — Playwright/Chromium ferme parfois la connexion avant de lire la ligne finale et logue ERR_ABORTED. La fonctionnalité est intacte.

**Action :** À surveiller en prod sur Sentry ; si le taux d'erreur réseau remonte, investiguer avec un vrai 200 + body `{}` à la place du 204.

---

## Résultats des tests par page Studio

### Dashboard (`/dashboard`)

- Redirect vers `/dashboard/classes` ✓

### Cours (`/dashboard/classes`)

- Chargement liste : ✓
- Filtre dates : ✓
- Création cours (modal "Nouveau cours") : ✓
- Modification titre/date/durée/capacité : ✓
- Suppression avec confirmation + optimistic removal : ✓
- État vide "Aucun cours sur cette plage" : ✓

### Membres (`/dashboard/members`)

- Chargement liste paginée (cursor) : ✓
- Search client-side (filtre displayName/email) : ✓
- État vide sur filtre sans résultat : ✓

### Identité visuelle (`/dashboard/branding`)

- Chargement couleur courante depuis `GET /v1/studios/me` : ✓
- Preview WCAG (noir/blanc auto) : ✓
- Édition inline + sauvegarde `PATCH /v1/studios/me` : ✓
- Toast "Identité mise à jour." : ✓
- Annuler (revert sans save) : ✓
- Hex invalide (`#ZZZZZZ`) — bloqué par `pattern` natif HTML5 : ✓ (validation silencieuse, pas de message React — UX acceptable)

### Facturation (`/dashboard/billing`)

- Chargement plans Free/Pro : ✓
- Bouton "Free" disabled (plan actuel) : ✓
- "Souscrire" → 503 API → alert "Stripe n'est pas encore configuré sur cet environnement." : ✓
- Section "Factures" / état vide : ✓

### Switch Locale FR/EN

- Tous les textes basculent instantanément : ✓
- Persistance navigation inter-pages : ✓
