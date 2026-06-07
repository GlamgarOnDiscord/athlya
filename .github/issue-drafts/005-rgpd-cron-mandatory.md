## Résumé

Le cycle RGPD `runScheduledRgpdMaintenance` est **skippé silencieusement** si `CRON_DB_URL` absent. Le rôle Postgres `athlya_cron` doit être provisionné **manuellement** (runbook Phase 8 « différable »). Sans cela, anonymisation audit J+30 et purge export_jobs/outbox ne tournent pas.

## Comportement attendu

- Soft-delete user → J+30 → `anonymize_user_audit(uuid)` exécuté automatiquement
- Production refuse deploy ou alerte si binding manquant
- Conformité Art. 5(1)(e) minimisation + Art. 17 effacement

## Comportement observé

`packages/api/src/worker.ts` scheduled handler :

```typescript
if (cronExecutor !== null) {
  /* run */
} else {
  console.info('CRON_DB_URL missing — skipping RGPD maintenance cycle');
}
```

Aucun fail-loud en staging/production.

## Impact

- **Sévérité** : Critical / P0 compliance
- PII dans `audit_log` **indéfiniment** après premier soft-delete
- Contradiction marketing « RGPD-first »
- Amende CNIL / plainte utilisateur

## Solution proposée

### 1. Migration grants (si manquante)

Vérifier/créer migration `0009_audit_cron_grants.sql` :

- `CREATE ROLE athlya_cron LOGIN` (password out-of-band)
- `GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron`
- Grants SELECT/UPDATE users, DELETE outbox/export_jobs

### 2. Fail-loud production

Comme `CORS_ORIGIN` sentinel dans `worker.ts` :

- Si `ENVIRONMENT === 'production'` && `CRON_DB_URL` empty → log error + Sentry + optionnel 500 config

### 3. Runbook non-différable

`docs/security/runbook-production-deploy.md` Phase 8 → **bloquant** avant premier utilisateur réel.

### 4. Observabilité

- Métrique/log structuré `rgpd_maintenance_cycle` avec count anonymized
- Alerte Axiom si skip ou 0 anonymized alors que users `deleted_at + 30d < now()`

### 5. Test

- Unit test scheduled runner avec mock SQL executor
- Test intégration anonymize (existe partiellement — étendre)

## Composants touchés

- [x] `@athlya/api/worker.ts`
- [x] `@athlya/db/migrations/`
- [x] `docs/security/runbook-production-deploy.md`
- [x] `@athlya/api/maintenance/scheduled-runner.ts`

## Critères d'acceptation

- [ ] Production deploy checklist exige `CRON_DB_URL`
- [ ] Skip RGPD = alerte ops (pas seulement console.info)
- [ ] E2E : soft-delete → advance clock/mock → audit anonymized
- [ ] DPO sign-off runbook Phase 8

## Références

- `docs/security/README.md` — backlog ops « Câblage worker.scheduled() »
- Migration `0003_audit_anonymization.sql`
- Audit infra 2026-05-27 — finding #5 Critical

## Priorité

**P0** — conformité RGPD avant prod publique
