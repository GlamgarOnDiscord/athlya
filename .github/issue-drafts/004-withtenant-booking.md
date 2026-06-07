## Résumé

Les transactions `bookClass` et `cancelReservation` **n'appellent pas** `withTenant()` — les GUC PostgreSQL `app.user_id`, `app.studio_id`, `app.role` ne sont pas injectés. L'isolation repose sur filtres applicatifs dans les adapters, pas sur RLS actif pendant le hot path.

## Comportement attendu

Req 13.1–13.6 : toute transaction authentifiée porte les session variables ; RLS FORCE comme dernier rempart.

## Comportement observé

`packages/api/src/adapters/reservations-deps.ts` L39–56 :

> `withTenant(claims, fn)` is intentionally NOT wired here yet

`createDrizzleBookingRepo` — INSERT sans `SET LOCAL`.

RLS sur `reservations`/`classes` **inactif** si requête sans GUC (fail-closed = 0 rows, ou bypass selon rôle connexion).

## Impact

- **Sévérité** : Critical / P0 sécurité
- Régression adapter = fuite cross-tenant potentielle
- pgTAP RLS validé en CI **ne couvre pas** ce chemin applicatif
- Contradiction doc « defense-in-depth » vs implémentation

## Solution proposée

### Option A — `withTenant` via postgres-js (immédiat)

Refactor `bookClass`/`cancelReservation` deps pour recevoir `TenantClaims` et wrapper :

```typescript
await withTenant(db, claims, async (tx) => {
  // booking repo methods on tx
});
```

Adapter `createDrizzleBookingRepo` pour accepter `AthlyaTx` pré-scopé.

### Option B — `withTenantHttp` statement-array (futur)

Pour réduire TCP : batch `SET LOCAL` + statements en une transaction HTTP Neon (slice B2 design doc).

### Tests obligatoires

- Intégration multi-tenant : user studio A ne peut pas book class studio B (404, 0 rows)
- pgTAP ou testcontainers P7 tenant isolation **dans CI principal**

## Composants touchés

- [x] `@athlya/api/adapters/reservations-write-drizzle.ts`
- [x] `@athlya/api/adapters/reservations-deps.ts`
- [x] `@athlya/reservations` — signature ports si nécessaire
- [x] `@athlya/db/client.ts` — `withTenantHttp` si Option B

## Critères d'acceptation

- [ ] Toute TX book/cancel exécute les 3 `set_config(..., true)`
- [ ] Test cross-tenant booking → `class_not_found` ou RLS 0 rows
- [ ] Suite pgTAP ou integration `multi-tenant-isolation` dans CI sans skip Docker
- [ ] Commentaire « intentionally NOT wired » supprimé

## Références

- `packages/db/src/client.ts` — `withTenant` L271+
- Migration `0004_rls_hardening.sql`
- Audit infra 2026-05-27 — finding #4 Critical

## Priorité

**P0** — sécurité multi-tenant hot path
