# Runbook — RGPD export (Articles 15/20)

Issue #498. Flow: `POST /v1/members/me/export` → `export_jobs` row + `members.export.requested`
outbox event (one statement) → queue consumer `runExportJob` → ZIP in R2 `EXPORTS_BUCKET` →
signed link `GET /v1/members/me/export/:jobId/download?exp&sig`.

## Prerequisites per environment

| Item                     | Where                                                    | Notes                                                                      |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Migrations `0032`–`0034` | Neon (migration role), in order                          | Service functions, auth events, export runtime. Apply **before** deploy.   |
| `EXPORTS_BUCKET`         | `wrangler r2 bucket create athlya-exports-{env}` + toml  | Private bucket. No public access, no custom domain.                        |
| `EXPORT_URL_SIGNING_KEY` | `wrangler secret put EXPORT_URL_SIGNING_KEY --env <env>` | ≥ 32 random chars (`openssl rand -base64 48`). Rotation invalidates links. |
| `API_PUBLIC_URL`         | `[env.<env>.vars]` in `packages/api/wrangler.toml`       | Public API origin; set for dev, staging and production. Preview: add it.   |
| R2 lifecycle rule        | `wrangler r2 bucket lifecycle add` (see below)           | Expires `exports/members/` objects after 3 days. Required everywhere.      |

```sh
wrangler r2 bucket lifecycle add athlya-exports-{env} expire-exports exports/members/ --expire-days 3
wrangler r2 bucket lifecycle list athlya-exports-{env}
```

The rule matches the 72 h download link: an archive is never served after its link expires, so R2
drops it shortly after (lifecycle deletion is asynchronous), whatever happens to the job row
(purged after 90 days by `purgeExpiredExportJobs`) or to the account.

Missing the bucket, the signing key or `API_PUBLIC_URL` makes jobs fail with a stable reason
instead of completing: `exports_bucket_missing` or `export_download_not_configured`. A missing
migration is different: requests fail with raw database errors instead — the enqueue is refused
(`42501`, no insert policy) or the worker hits an undefined `export_job_*` function (`42883`).

## Guarantees

- **Producer**: a member can only insert their own `pending` job (`export_jobs_insert_own`); the
  event is in the outbox in the same statement, so a queue outage delays the export but never
  strands it.
- **Worker** (`athlya_app`, no tenant claims): `export_job_claim` is an atomic
  `pending → running` with a 15 min lease and returns a fresh `claim_token`. A second delivery
  gets `in_progress`; a crashed run is reclaimed on redelivery after the lease, which rotates the
  token. `export_job_complete` / `export_job_fail` require the current token, so a slow run whose
  lease was reclaimed can neither complete nor fail the newer run. Archives are stored per claim
  (`exports/members/{jobId}/{claimToken}.zip`) and the download serves the key of the claim on
  the completed row, so a stale upload never replaces the published archive. Personal data is
  readable only through the claimed job (`export_job_profile`, `export_job_rows`), never by bare
  user id.
- **Archive cleanup** (best effort, never changes the job outcome): a run that completes deletes
  every other object under `exports/members/{jobId}/`; a run that loses its claim or fails after
  uploading deletes its own upload. The lifecycle rule removes whatever a crash leaves behind.
- **Account deletion** (Article 17): the cascade does not touch `export_jobs`, and the download
  needs the owner's JWT, which a deleted account can no longer obtain. Its archives expire with
  the lifecycle rule (≤ 3 days).
- **Download**: the link is an HMAC over `jobId.exp` (72 h) **and** the route requires the
  owner's JWT and reads the job through `export_jobs_read_own`. Response is
  `Cache-Control: private, no-store`.
- **CSV**: cells starting with `= + - @`, tab/CR/LF or their full-width forms are prefixed with
  `'` (formula injection). JSON files keep raw values — negative numbers read `'-5` in CSV.

## Archive contents

`profile.json`, `consents.json`, `reservations.{json,csv}`, `workout_sessions.{json,csv}`,
`checkins.{json,csv}`, `invoices.{json,csv}`, `audit_trail.json`.
Invoices are empty until billing records are persisted (issue #122). Audit rows the user wrote are
exported in full; rows about the user written by another actor are exported with `actorId: null`
and only the `subjectUserId`, `eventType` and `revision` metadata keys (everything else is
dropped, so free-form metadata cannot disclose that actor).

## Checks

```sql
-- Jobs stuck running past the lease (should be empty; redelivery reclaims them)
SELECT id, user_id, started_at FROM export_jobs
 WHERE status = 'running' AND started_at < now() - interval '15 minutes';

-- Failure reasons of jobs requested in the last 24 h (no failure timestamp is stored)
SELECT error, count(*) FROM export_jobs
 WHERE status = 'failed' AND requested_at > now() - interval '24 hours' GROUP BY 1;
```
