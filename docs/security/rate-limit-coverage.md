# Rate-limit coverage matrix (issue #133)

Audit finding **C7** — documenter et durcir les reads coûteux quand Redis est indisponible.

**Source code** : `packages/api/src/middleware/rate-limit-policies.ts` (registry) + `packages/api/src/worker.ts` (mounts).

## Politiques fail-open / fail-closed

| Politique          | Comportement Redis down       | HTTP                                        | Issues                             |
| ------------------ | ----------------------------- | ------------------------------------------- | ---------------------------------- |
| `fail-closed`      | Requête bloquée               | **503** `dependency_unavailable`            | #65 mutations, #133 reads coûteux  |
| `fail-closed-soft` | Requête bloquée (synthétique) | **429** `rate_limit_dependency_unavailable` | #128 global `/v1/*`                |
| `fail-open`        | Requête laissée passer        | —                                           | `studioRateLimit()` domain routers |

`ENVIRONMENT=dev` bypass tous les limiters gateway (comportement inchangé).

## Matrice route × budget × policy

| ID                     | Route                                                   | Methods | Budget (60s sauf export)       | Fail policy      | Bucket       |
| ---------------------- | ------------------------------------------------------- | ------- | ------------------------------ | ---------------- | ------------ |
| `global-v1`            | `/v1/*`                                                 | \*      | 1000 IP / 5000 user (defaults) | fail-closed-soft | ip+user      |
| `auth`                 | `/v1/auth/*`                                            | \*      | 20 IP                          | fail-closed      | ip           |
| `reservation-mutation` | `POST /v1/reservations`                                 | POST    | 10 user                        | fail-closed      | user         |
| `reservation-cancel`   | `DELETE /v1/reservations/:id`                           | DELETE  | 10 user                        | fail-closed      | user         |
| `profile-patch`        | `PATCH /v1/me`                                          | PATCH   | 5 user                         | fail-closed      | user         |
| `consents-patch`       | `PATCH /v1/me/consents`                                 | PATCH   | 5 user                         | fail-closed      | user         |
| `export-post`          | `POST /v1/members/me/export`                            | POST    | 1 / 24h user                   | fail-closed      | user         |
| `coach-ask`            | `POST /v1/coach/ask`                                    | POST    | 5 user + 10 / UTC day quota    | fail-closed      | user         |
| `session-post`         | `POST /v1/sessions`                                     | POST    | 20 user                        | fail-closed      | user         |
| `classes-search`       | `GET /v1/classes/search`                                | GET     | 30 IP                          | **fail-closed**  | ip (pre-jwt) |
| `members-list`         | `GET /v1/members` (exact)                               | GET     | 20 IP                          | **fail-closed**  | ip (pre-jwt) |
| `audit-list`           | `GET /v1/audit`                                         | GET     | 30 IP                          | **fail-closed**  | ip (pre-jwt) |
| `progression-read`     | `GET /v1/me/progression`                                | GET     | 30 IP (`rl:ip:progression`)    | **fail-closed**  | ip (pre-jwt) |
| `admin-stats`          | `GET /admin/{dlq,outbox}/stats`, `GET /admin/jwt/state` | GET     | 10 user / 5 IP                 | **fail-closed**  | ip+user      |
| `studio-burst`         | Domain routers authentifiés                             | \*      | 1000 / studio                  | fail-open        | studio       |

`/v1/members/me` et sous-routes ne matchent **pas** le limiter `members-list` (garde `isMembersListGetPath`).

Mutation limiters (issue #613) run an inline `jwtAuth()` pre-pass before the limiter: unauthenticated requests get a 401 without touching a mutation bucket (the global `/v1/*` IP bucket still applies), and authenticated ones are keyed on `rl:user:mutation-<scope>:<userId>`, so the budget follows the user across IPs and users behind one IP get independent budgets.

`coach-ask` (Epic 21) is mounted in the coach router (`routes/coach.ts`), after `jwtAuth` and the `ai-coach` flag check: with the flag off the route answers 404 and no bucket is touched. It adds a daily quota per member (`AI_COACH_DAILY_LIMIT`, default 10, UTC day) kept in the Redis counter `coach:quota:<day>:<userId>` by the use case. It fails closed too: a Redis error answers 503 `dependency_unavailable` before any model call, and an exhausted quota answers 429 `coach_quota_exceeded` with `Retry-After` set to the next UTC midnight.

Les limiters reads coûteux sont montés **avant** `jwtAuth` → bucket **IP** sur le limiter dédié ; le global `/v1/*` applique quand même le bucket user si le JWT est présent.

## Defense-in-depth

1. **Global** `/v1/*` fail-closed-soft (#128) — filet pour tout read ordinaire.
2. **Reads coûteux** fail-closed dédié (#133) — 503 même si bug de routing bypassait le global.
3. **Admin stats** montés **avant** `jwtAuth` — flood non authentifié bloqué en outage Redis.
4. **Cloudflare WAF** (dashboard) — rate limit `/v1/auth/*` ~100 req/min/IP recommandé (`audit-S4-network.md`).

## Vérification

```powershell
pnpm --filter @athlya/api test -- src/__tests__/rate-limit-policies.test.ts src/__tests__/expensive-read-limiter-redis-down.test.ts
node scripts/verify-rate-limit-coverage-checklist.mjs
```

## Références

- `packages/api/src/middleware/limiter-guard.ts`
- `docs/security/audit-S4-network.md` § Issue #65
- Audit prod 2026-05-27 — C7
