$ErrorActionPreference = "Stop"
Set-Location "c:\Users\Tom\Downloads\appli-salle-de-sport"

$issues = @(
  @{ file="002-capacity-postgres-guard.md"; title="[P0][bug] Garde capacity PostgreSQL sur bookClass (surbooking Redis-only)"; labels="bug,production-blocker,priority: critical,area: db,area: reservations" },
  @{ file="003-hyperdrive-write-path.md"; title="[P0][infra] Hyperdrive + pooling connexions Neon sur le write path booking"; labels="enhancement,production-blocker,priority: critical,infra,performance,area: api" },
  @{ file="004-withtenant-booking.md"; title="[P0][security] withTenant/RLS sur le hot path bookClass et cancelReservation"; labels="bug,production-blocker,priority: critical,security,area: db,area: reservations" },
  @{ file="005-rgpd-cron-mandatory.md"; title="[P0][compliance] CRON_DB_URL obligatoire et role athlya_cron pour anonymisation J+30"; labels="bug,production-blocker,priority: critical,compliance,area: api" },
  @{ file="006-fail-closed-rate-limit.md"; title="[P1][security] Fail-closed rate limit et concurrency sur mutations critiques"; labels="enhancement,priority: high,security,area: api" },
  @{ file="007-eu-data-residency.md"; title="[P1][compliance] EU data residency - region pin Workers et Hyperdrive EU"; labels="enhancement,priority: high,compliance,infra" },
  @{ file="008-ci-gates-mandatory.md"; title="[P1][infra] CI gates obligatoires - Testcontainers PBT, k6 staging, ZAP baseline"; labels="enhancement,priority: high,area: ci,infra" },
  @{ file="009-preview-pr-race.md"; title="[P1][infra] Preview PR - eliminer la race sur secret DB_URL partage"; labels="bug,priority: high,area: ci,infra" },
  @{ file="010-stripe-production.md"; title="[P1][billing] Stripe production - webhook fail-closed et idempotency events"; labels="enhancement,priority: high,area: billing" },
  @{ file="011-mobile-expo-epic.md"; title="[P1][feat] Epic 11 - Application mobile Expo SDK 55 (0/13 taches)"; labels="enhancement,priority: high,area: mobile" },
  @{ file="012-health-ready-gate.md"; title="[P1][infra] Deploy gate sur /health/ready (readiness probe)"; labels="enhancement,priority: high,infra,area: api" },
  @{ file="013-outbox-drain-alerting.md"; title="[P1][perf] Outbox drain - latence cron 1 min et alerting backlog"; labels="enhancement,priority: high,performance,area: api" },
  @{ file="014-circuit-breaker-redis.md"; title="[P1][infra] Circuit breaker Redis-backed (remplacer etat per-isolate)"; labels="enhancement,priority: high,infra,area: api" },
  @{ file="015-admin-hardening.md"; title="[P2][security] Durcissement surface admin (/admin/*)"; labels="enhancement,priority: medium,security,area: api" },
  @{ file="016-csp-style-refactor.md"; title="[P2][security] CSP - refactor styles inline vers CSS variables"; labels="enhancement,priority: medium,security" },
  @{ file="017-sentry-otel-sdk.md"; title="[P2][infra] Remplacer Sentry/OTel hand-rolled par SDKs officiels"; labels="enhancement,priority: medium,infra,area: api" },
  @{ file="018-jwt-rotation-automation.md"; title="[P2][infra] Automatiser rotation JWT (admin + wrangler secrets)"; labels="enhancement,priority: medium,infra,area: api" },
  @{ file="019-bcrypt-password-length.md"; title="[P2][security] bcrypt - aligner Zod max password sur limite 72 bytes"; labels="bug,priority: medium,security,area: api" },
  @{ file="020-audit-residual-findings.md"; title="[P2][security] Backlog findings audit MEDIUM/LOW residuels (17+ items)"; labels="documentation,priority: medium,security" },
  @{ file="021-canary-deploy.md"; title="[P2][infra] Canary deploy Cloudflare Workers (trafic graduel)"; labels="enhancement,priority: medium,infra,area: ci" },
  @{ file="022-queue-topology.md"; title="[P2][infra] Topologie queues par domaine (eviter SPOF logique)"; labels="enhancement,priority: medium,infra,area: api" },
  @{ file="023-cost-alerting.md"; title="[P2][infra] Alerting couts operationnels Upstash/Neon/Workers"; labels="documentation,priority: medium,infra" },
  @{ file="024-otel-sampling.md"; title="[P2][infra] Reduire head_sampling_rate OTel en production"; labels="enhancement,priority: medium,infra,performance" },
  @{ file="025-terraform-iac.md"; title="[P3][infra] Infrastructure as Code - Terraform pour bindings CF/Neon"; labels="enhancement,priority: low,infra" },
  @{ file="026-eslint-flat-config.md"; title="[P3][infra] Migrer apps/web vers ESLint 9 flat config unique"; labels="enhancement,priority: low,area: ci" },
  @{ file="027-expo-push-scc.md"; title="[P3][compliance] Expo Push - SCC transfert hors UE (Art. 44 RGPD)"; labels="enhancement,priority: low,compliance,area: mobile" }
)

$results = @("https://github.com/GlamgarOnDiscord/athlya/issues/60")
foreach ($i in $issues) {
  $path = ".github/issue-drafts/$($i.file)"
  Write-Host "Creating: $($i.title)"
  $url = gh issue create --title $i.title --label $i.labels --body-file $path
  $results += $url
  Start-Sleep -Milliseconds 900
}

$results | Out-File -Encoding utf8 ".github/issue-drafts/created-urls.txt"
Write-Host "Done. $($results.Count) total issues."
