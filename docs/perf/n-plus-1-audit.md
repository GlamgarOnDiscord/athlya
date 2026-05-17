# N+1 audit (slice B5.5)

Cette page audite les chemins de lecture potentiellement N+1 dans le backend Athlya. Date : Vague 21.

## Définition retenue

Un N+1 est défini ici comme : **N appels round-trip _séquentiels_ vers une dépendance externe (PG ou Redis) déclenchés par un seul fetch parent**. Les `Promise.all` parallélisés sur Redis ne sont pas des N+1 (1 fan-out parallèle ≪ N round-trips séquentiels en latence).

## Audit

### 1. `listClasses` (Req 7.1) — `packages/reservations/src/list.ts`

```ts
const rows = await deps.classRepo.findInRange(studioId, range);
const remainings = await Promise.all(
  rows.map(async (row) => {
    const remote = await deps.counter.getRemaining(row.id);
    return remote ?? row.capacity;
  }),
);
```

**Pattern** : 1 SQL pour les rows + N reads Redis lancés en parallèle via `Promise.all`. Le client Redis Upstash supporte le pipelining HTTP : les N lectures partent en flight ensemble et la latence end-to-end est dominée par 1 round-trip + traitement parallèle, pas N round-trips.

**Verdict** : ✅ pas un N+1. Comportement déjà optimal.

### 2. `listMyReservations` (Req 7.4) — `packages/api/src/adapters/reservations-list-drizzle.ts`

```sql
SELECT r.*, c.title, c.starts_at, c.duration_min
FROM reservations r
JOIN classes c ON c.id = r.class_id
WHERE r.user_id = $1
  AND c.starts_at BETWEEN $2 AND $3
ORDER BY c.starts_at ASC
LIMIT $4;
```

**Pattern** : 1 seul SELECT avec un JOIN. La projection `c.title`, `c.starts_at`, `c.duration_min` est faite côté SQL — pas de fetch additionnel par row.

**Verdict** : ✅ pas un N+1.

### 3. `listMembersByStudio` — `packages/api/src/adapters/members-repo-drizzle.ts`

Pseudocode :

```sql
SELECT id, email, display_name, role, created_at
FROM users
WHERE studio_id = $1 AND deleted_at IS NULL AND ($2 IS NULL OR id > $2)
ORDER BY id LIMIT $3;
```

**Pattern** : 1 seul SELECT, pagination cursor.

**Verdict** : ✅ pas un N+1.

### 4. `bookClass` (Req 8.1) — `packages/reservations/src/book.ts`

```ts
return db.transaction(async (tx) => {
    const cls = await tx.select(...).from(classes).where(eq(classes.id, classId));
    if (!cls) throw new ClassNotFound();
    // counter.peek + decrement + INSERT reservations
    ...
});
```

**Pattern** : 1 SQL pour la classe + 1 INSERT (avec UNIQUE check). Pas de fan-out par capacity-slot.

**Verdict** : ✅ pas un N+1.

### 5. `cancelReservation` (Req 9.1) — `packages/reservations/src/cancel.ts`

Une seule transaction :

- 1 UPDATE sur la reservation cancellée.
- 1 SELECT FOR UPDATE sur la prochaine waitlistée éligible (FIFO promotion).
- 1 UPDATE pour la promouvoir si elle existe.

**Pattern** : O(1) round-trips (3 statements dans une transaction unique). Pas de boucle.

**Verdict** : ✅ pas un N+1.

### 6. Drain worker — `packages/api/src/events/drain-scheduled.ts`

```ts
const events = await claimBatch(db, BATCH_SIZE);
for (const event of events) {
  await queue.send(event);
  await markPublished(db, event.id);
}
```

**Pattern** : N round-trips (queue.send + markPublished) par batch de events. C'est un N+1 _structuré_ : on ne peut pas batcher la publication en queue (Cloudflare Queues n'a pas d'API batch côté producer dans le runtime Workers).

**Verdict** : ⚠️ acceptable parce que le drain tourne en background (cron 1 min), pas sur le hot path utilisateur. Si la latence de drain devenait un problème, deux optimisations seraient possibles :

1. Batcher les `markPublished` en un seul `UPDATE outbox SET published_at = NOW() WHERE id = ANY($1)` après que les `queue.send` aient toutes succeeded.
2. Lancer les `queue.send` en parallèle via `Promise.all` (Cloudflare Queues supporte ~100 in-flight sends par isolate).

Ces deux optimisations ne sont pas implémentées aujourd'hui car les volumes restent < 100 events/min et la latence du drain n'est pas observée. Re-évaluer en B7 quand l'OTel queue lag sera collecté.

### 7. `findStudioBySlug` (tenant resolver) — `packages/api/src/middleware/tenant-resolver.ts`

```sql
SELECT id, slug, name FROM studios WHERE slug = $1;
```

**Pattern** : 1 SELECT, mémoïsé par isolate via `getOrCreateTenantCache` (Vague 18 / B1). Au-delà du premier hit froid, c'est zéro round-trip.

**Verdict** : ✅ pas un N+1.

## Conclusion

**Aucun N+1 critique sur les hot paths utilisateur.** Le seul "structurel" est dans le drain worker qui tourne en background (cron 1 min) et reste tolérable jusqu'à ~100 events/min. Aucune optimisation n'est nécessaire en B5 ; le sujet sera ré-évalué en B7 (observability) avec des métriques réelles.
