## Résumé

Rate limit, concurrency limit et tenant claim guard adoptent une politique **fail-open** si Upstash Redis ou Postgres slug lookup est indisponible. Sous incident dépendance, l'API devient **sans protection** sur les mutations coûteuses.

## Comportement observé

- `worker.ts` `guardLimiter` — catch Upstash → proceed sans limit
- `concurrency-limit.ts` L213 — Redis unreachable → fail-open
- `tenant-resolver.ts` — DB outage → warn + let through

## Impact

- **Sévérité** : High / P1
- DDoS applicatif amplifié pendant panne Redis
- Credential stuffing `/v1/auth/*` si rate limit down
- Booking storm sur PG déjà fragile

## Solution proposée

### Fail-closed ciblé (mutations)

| Route                        | Policy si Redis down         |
| ---------------------------- | ---------------------------- |
| `POST /v1/auth/login`        | 503 `dependency_unavailable` |
| `POST /v1/reservations`      | 503                          |
| `POST /v1/members/me/export` | 503                          |
| `GET /v1/classes`            | fail-open OK (read)          |

### Backup layer

- Cloudflare WAF rate rules (100 req/min/IP sur `/v1/auth/*`)
- Documenter dans `docs/security/audit-S4-network.md`

### Health signal

`/health/ready` redis=failed → deploy automation hold

## Critères d'acceptation

- [ ] Mutations critiques fail-closed si Redis ping fail (staging/prod)
- [ ] Reads restent fail-open
- [ ] Tests unit `rate-limit.test.ts` + `concurrency-limit.test.ts` étendus
- [ ] Runbook incident « Redis down »

## Priorité

**P1** — avant prod publique
