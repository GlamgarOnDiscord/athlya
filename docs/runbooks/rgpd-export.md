# Runbook — RGPD export (Articles 15/20)

Issue #498. Flow: `POST /v1/members/me/export` → `export_jobs` row + `members.export.requested`
outbox event (one statement) → queue consumer `runExportJob` → ZIP in R2 `EXPORTS_BUCKET` →
signed link `GET /v1/members/me/export/:jobId/download?exp&sig`.

## Prerequisites per environment

| Item                     | Where                                                    | Notes                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations `0032`–`0034` | Neon (migration role), in order                          | Service functions, auth events, export runtime. Apply **before** deploy.                                                                                                                                                   |
| `EXPORTS_BUCKET`         | `wrangler r2 bucket create athlya-exports-{env}` + toml  | Private bucket. No public access, no custom domain. Bound in `wrangler.toml` (consumer writes) and `wrangler.reservations.toml` (`/v1/members/*` download), same name.                                                     |
| `EXPORT_URL_SIGNING_KEY` | `wrangler secret put EXPORT_URL_SIGNING_KEY --env <env>` | ≥ 32 random chars (`openssl rand -base64 48`). Rotation invalidates links. Same value on the gateway (signs) and with `-c wrangler.reservations.toml` (verifies `/v1/members/*`). Checked by `scripts/verify-secrets.mjs`. |
| `API_PUBLIC_URL`         | `[env.<env>.vars]` in `packages/api/wrangler.toml`       | Public API origin; set for dev, staging and production. Preview: add it.                                                                                                                                                   |
| R2 lifecycle rule        | `wrangler r2 bucket lifecycle add` (see below)           | Expires `exports/members/` objects after 3 days. Required everywhere.                                                                                                                                                      |

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

`README.txt`, `profile.json`, `consents.json`, `reservations.{json,csv}`,
`workout_sessions.{json,csv}`, `checkins.{json,csv}`, `invoices.{json,csv}`, `audit_trail.json`.

`README.txt` describes each file and the CSV encoding (UTF-8, CRLF, every cell quoted, formula
prefix).

**Workout sessions** carry `cardio` (migration `0046`) when they have a structured cardio summary,
and `source` / `externalId` (migration `0049`, issue #690) when they were imported from another
app: the provider (`appleHealth`) and the workout id there (the HealthKit workout UUID). Sessions
without them keep the shorter JSON shape. `workout_sessions.csv` has the columns `id, userId,
studioId, startedAt, durationMin, exercisesJson, notes, cardioJson, createdAt, source,
externalId`; a session without these values leaves their cells empty.

**Invoices: members have no invoices in v1.** Athlya only bills studios for their own platform
subscription (`studio_invoices`, migration `0036`, issue #122). Those invoices belong to the
studio, carry no member id and are not a member's personal data, so they are not exported.
Member → studio payments (Stripe Connect) are out of scope for v1 and nothing billed to a member
is stored. The archive keeps `invoices.json` (`[]`) and `invoices.csv` (header row only) so its
schema stays stable, and `README.txt` says why. When member billing ships, implement
`listInvoices` in `packages/api/src/adapters/export-data-source.ts` through the claimed job (like
`export_job_rows`) and update the README text (`MEMBER_INVOICES_NOTE` in `@athlya/members`).

Audit rows the user wrote are
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

## Staging E2E

`scripts/smoke-e2e-export.mjs` proves the whole flow on staging with the real Postgres, Queue and
R2 bindings:

1. logs in as the smoke account and as a second, unrelated account;
2. logs a workout session whose notes are a CSV-injection probe (`=HYPERLINK(…)`, quotes, comma,
   CRLF). Sessions cannot be deleted through the API, so each run adds one to the smoke account;
3. `POST /v1/members/me/export`, then polls the job (default timeout 15 min);
4. checks the signed expiry is 72 h after completion and matches `downloadExpiresAt`;
5. downloads the archive through the signed link (it refuses a link on another origin, so the
   token never leaves the API) and validates it: exact file list, CRC-32, JSON/CSV row counts,
   CSV headers, strict quoting and CRLF, no unneutralised formula cell, and the probe escaped
   (`'` prefix, doubled quotes) in CSV and raw in JSON;
6. requires the link to be refused with no token (`401`), for the other account (`403`/`404`),
   with a tampered signature, a past expiry or a stretched expiry (`403`), and the job status to
   be hidden from the other account (`404`).

It is **not** in the per-PR staging gate: the export is limited to one request per user per 24 h
(`export-post` rate-limit policy), so a second gate run on the same day would always fail. It runs
from `.github/workflows/staging-export-e2e.yml` weekly (Tuesday 06:17 UTC) and on demand
(`workflow_dispatch`). A rerun inside the 24 h window passes `job_id` (manual input or
`--job-id`) to re-validate the export already requested; the probe check is then skipped.

Configuration (environment `staging`, the run fails when any required item is missing):

| Name                                                        | Kind    | Notes                                                 |
| ----------------------------------------------------------- | ------- | ----------------------------------------------------- |
| `STAGING_API_URL`, `STAGING_SMOKE_STUDIO_SLUG`              | vars    | Shared with the staging gate.                         |
| `STAGING_SMOKE_EMAIL`, `STAGING_SMOKE_PASSWORD`             | secrets | Shared with the staging gate.                         |
| `STAGING_SMOKE_OTHER_EMAIL`, `STAGING_SMOKE_OTHER_PASSWORD` | secrets | Second account (any studio), never the smoke account. |
| `STAGING_SMOKE_TURNSTILE_TOKEN`                             | secret  | Optional; owner login.                                |
| `STAGING_SMOKE_OTHER_TURNSTILE_TOKEN`                       | secret  | Optional; other-account login (falls back to above).  |

A Turnstile token is single-use, so stored tokens only work with Cloudflare's Turnstile test secret
on staging (any token passes, repeatedly). Access tokens live 15 min; the script refreshes both
sessions through `POST /v1/auth/refresh` while it waits for the job.

Local run:

```sh
export SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_STUDIO_SLUG=…
export SMOKE_OTHER_EMAIL=… SMOKE_OTHER_PASSWORD=…
node scripts/smoke-e2e-export.mjs --base-url https://staging.api.athlya.app
```

Optional: export `SMOKE_TURNSTILE_TOKEN` / `SMOKE_OTHER_TURNSTILE_TOKEN` first, and append
`--timeout-sec 900` or `--job-id` followed by an existing job id.

The pure parts (ZIP reader, strict CSV parser, archive validator, link and expiry checks, the flow
against a fake API) are covered by `scripts/__tests__/smoke-export.test.mjs`
(`pnpm test:scripts`). `CSV_HEADERS` in the script mirrors `buildArchiveEntries` in
`@athlya/members`: change both together (the test fixture hard-codes the same contract).
