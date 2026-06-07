## Résumé

Plusieurs workflows CI sont **opt-in via vars vides** : k6 load test, OWASP ZAP, Testcontainers PBT (P1 capacity, P7 tenant). Le job `ci.yml` principal skip les suites Docker. Les badges README sur-vendent la couverture réelle.

## Comportement observé

| Workflow           | Gate                       | État typical fork       |
| ------------------ | -------------------------- | ----------------------- |
| `load-test.yml`    | `vars.K6_STAGING_BASE_URL` | skip                    |
| `zap-baseline.yml` | `vars.ZAP_TARGET_URL`      | skip                    |
| `ci.yml` pnpm test | Docker absent              | skip Testcontainers     |
| `pgtap.yml`        | SQL paths only             | OK mais pas booking PBT |

## Impact

- **Sévérité** : High / P1
- Merge possible sans jamais valider SLO p99 ni contention booking
- Régression wiring (pattern audit S1) non détectée

## Solution proposée

### 1. Job CI `integration-docker` sur `master`

```yaml
# .github/workflows/integration-docker.yml
services: postgres:17, redis:7
run: pnpm --filter @athlya/reservations test -- --run property
```

Paths : `packages/reservations/**`, `packages/api/**`, `packages/members/**`

### 2. Vars obligatoires org repo

Documenter dans `.github/READ_ME.md` :

- `K6_STAGING_BASE_URL` — required for main branch protection
- `ZAP_TARGET_URL` — idem

### 3. Branch protection rules

- Require `integration-docker` + `pgtap` + `ci` on `master`

### 4. Fail loud si vars missing on main

Workflow scheduled weekly qui vérifie vars et ouvre issue si absent.

## Critères d'acceptation

- [ ] PBT P1/P7 exécutés en CI sur master (Docker)
- [ ] k6 + ZAP documentés comme required vars
- [ ] Branch protection configurée (doc ops si pas accès)
- [ ] README badges clarifiés (« CI unit » vs « CI full »)

## Priorité

**P1**
