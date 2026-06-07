## Résumé

L'invariant « zéro surbooking » repose **exclusivement** sur un counter Redis (`class:{id}:remaining`) sans garde PostgreSQL. `bookClass` n'exécute ni `SELECT FOR UPDATE` sur `classes`, ni vérification `COUNT(confirmed) <= capacity`, ni trigger/contrainte DB.

## Comportement attendu

Req 8.3 : à tout instant, `count(reservations WHERE status='confirmed' AND class_id=X) <= classes.capacity`.

Double défense : Redis (optimiste) + Postgres (autoritaire).

## Comportement observé

`packages/reservations/src/book.ts` :

1. `DECR` Redis
2. `INSERT confirmed` sans lock capacity

`packages/api/src/adapters/reservations-write-drizzle.ts` — `insertReservation` = INSERT direct.

Scénarios de failure :

- Key Redis absente/evicted → drift
- Worker crash après DECR, avant INCR compensatoire → counter sous-estimé → surbooking
- Redis indisponible + fail-open rate limit → tempête de bookings

## Impact

- **Sévérité** : Critical / P0
- Surbooking réel en prod sous contention ou incident Redis
- PBT P1 (capacity) validé en Testcontainers **non exécuté en CI principal**

## Solution proposée

### Option A — Trigger PostgreSQL (recommandée)

```sql
CREATE OR REPLACE FUNCTION enforce_class_capacity()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    IF (SELECT COUNT(*) FROM reservations
        WHERE class_id = NEW.class_id AND status = 'confirmed') >=
       (SELECT capacity FROM classes WHERE id = NEW.class_id) THEN
      RAISE EXCEPTION 'class_capacity_exceeded' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Migration `0007_capacity_guard.sql` + `.down.sql` + test pgTAP.

### Option B — Transaction avec lock

Dans `createDrizzleBookingRepo`, avant INSERT :

```sql
SELECT capacity FROM classes WHERE id = $1 FOR UPDATE;
SELECT COUNT(*) FROM reservations WHERE class_id = $1 AND status = 'confirmed';
```

### Option C — Réconciliation cron

Job `reconcileCapacityCounters()` : resync Redis depuis PG toutes les 5 min (complément, pas substitut).

## Composants touchés

- [x] `@athlya/db` — migration trigger ou fonction
- [x] `@athlya/reservations` — gestion erreur `class_full` si trigger
- [x] `@athlya/api` — mapping Problem Details
- [x] Tests PBT P1 + pgTAP

## Critères d'acceptation

- [ ] Impossible d'insérer `confirmed` au-delà de `capacity` même si Redis = 999
- [ ] Property test P1 passe avec Redis désactivé/fake
- [ ] Migration réversible
- [ ] Pas de régression waitlist path

## Références

- `packages/reservations/src/book.ts` Algorithm 1
- Design doc §3.2 — Redis as optimistic layer, PG as source of truth
- Audit infra 2026-05-27 — finding #2 Critical

## Priorité

**P0** — invariant métier #1
