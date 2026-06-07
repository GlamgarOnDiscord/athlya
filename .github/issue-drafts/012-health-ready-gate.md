## Résumé

`/health` (liveness) ne ping aucune dépendance — Cloudflare uptime peut rester vert pendant blackout PG/Redis. `/health/ready` existe (CN.9.4) mais **n'est pas utilisé** comme gate deploy.

## Comportement observé

`worker.ts` L827-834 — health retourne ok sans DB/Redis.

`/health/ready` — probe 2s timeout, fail-closed staging/prod si deps missing.

## Impact

- **Sévérité** : High / P1 ops
- Deploy réussi → trafic vers Worker incapable de servir
- Incident prolongé invisible aux sondes default

## Solution proposée

### 1. Deploy automation

Script post-`wrangler deploy` :

```bash
for i in {1..30}; do
  curl -sf https://api.athlya.app/health/ready || sleep 2
done
```

Fail deploy si 503 persistant.

### 2. BetterStack / Uptime

- Liveness : `/health` (process alive)
- Readiness : `/health/ready` (deps OK) — **alerte P1**

### 3. Cloudflare Load Balancer (optionnel)

Pool health check → `/health/ready`

### 4. Doc

`docs/security/runbook-production-deploy.md` Phase 7 — ajouter curl ready

## Critères d'acceptation

- [ ] Runbook deploy utilise `/health/ready`
- [ ] Uptime monitor configuré (doc ops)
- [ ] Test : staging avec DB_URL invalid → ready=503

## Priorité

**P1**
