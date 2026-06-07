$ErrorActionPreference = "Stop"
Set-Location "c:\Users\Tom\Downloads\appli-salle-de-sport"

$issues = @(
  @{ file="028-rls-db-cutover.md"; title="[P0][security] Cutover DB_URL vers athlya_app (RLS reel en production)"; labels="bug,production-blocker,priority: critical,security,area: db,compliance" },
  @{ file="029-audit-log-insert-athlya-app.md"; title="[P0][security] Migration audit_log INSERT pour role athlya_app (debloquer cutover RLS)"; labels="bug,production-blocker,priority: critical,security,area: db" },
  @{ file="030-hyperdrive-provisioned.md"; title="[P0][infra] Provisionner Hyperdrive staging+prod (bindings actifs)"; labels="enhancement,production-blocker,priority: critical,infra,performance,area: api" },
  @{ file="031-axiom-alerts-provision.md"; title="[P0][ops] Provisionner 13 alertes Axiom + DLQ/outbox backlog"; labels="enhancement,production-blocker,priority: critical,infra,area: api" },
  @{ file="032-cf-access-admin-enforced.md"; title="[P0][security] Enforcer Cloudflare Access sur /admin/* (pas doc only)"; labels="enhancement,production-blocker,priority: critical,security,area: api" },
  @{ file="033-stripe-production-live.md"; title="[P0][billing] Stripe production live (secrets, Connect, webhook reel)"; labels="enhancement,production-blocker,priority: critical,area: billing" },
  @{ file="034-github-actions-billing.md"; title="[P0][infra] Restaurer CI GitHub Actions (quota billing / self-hosted)"; labels="bug,production-blocker,priority: critical,infra,area: ci" },
  @{ file="035-readme-mobile-honesty.md"; title="[P1][docs] README architecture honnete: retirer mobile v1.0 du chemin critique"; labels="documentation,priority: high,area: mobile" },
  @{ file="036-queue-split-implementation.md"; title="[P1][infra] Implementer split queues events (ADR vers code)"; labels="enhancement,priority: high,infra,area: api" },
  @{ file="037-qstash-quota-alerting.md"; title="[P1][ops] Alerting quota QStash/Upstash reminders"; labels="enhancement,priority: high,infra,performance" },
  @{ file="038-audit-log-wiring-admin-billing.md"; title="[P1][security] Brancher audit log JWT rotate + billing webhook + DLQ admin"; labels="enhancement,priority: high,security,compliance,area: api" },
  @{ file="039-global-rate-limit-fail-open.md"; title="[P1][security] Reduire fail-open global rate limit si Redis down"; labels="enhancement,priority: high,security,area: api" },
  @{ file="040-canary-deploy-automation.md"; title="[P1][infra] Canary deploy automatise (Workers versions API)"; labels="enhancement,priority: high,infra,area: ci" },
  @{ file="041-deploy-production-workflow.md"; title="[P1][infra] Workflow deploy-production.yml + gate health/ready"; labels="enhancement,priority: high,infra,area: ci" },
  @{ file="042-turnstile-forgot-password.md"; title="[P1][security] Turnstile sur forgot-password en production"; labels="enhancement,priority: high,security,area: api" },
  @{ file="043-unknown-queue-events-dlq.md"; title="[P2][bug] Events queue inconnus: DLQ + metrique au lieu de ack silencieux"; labels="bug,priority: medium,area: api" },
  @{ file="044-rate-limit-route-coverage.md"; title="[P2][security] Revue couverture rate limit routes (matrice fail-open/closed)"; labels="enhancement,priority: medium,security,area: api" },
  @{ file="045-outbox-adaptive-drain.md"; title="[P2][perf] Outbox drain adaptatif + metrique backlog"; labels="enhancement,priority: medium,performance,area: api" },
  @{ file="046-redis-pg-capacity-reconcile.md"; title="[P2][bug] Reconciliation Redis vs Postgres capacity drift"; labels="bug,priority: medium,area: reservations,area: db" },
  @{ file="047-csp-report-to.md"; title="[P2][security] CSP report-to endpoint + alerting violations"; labels="enhancement,priority: medium,security" },
  @{ file="048-csp-style-src-attr-residual.md"; title="[P2][security] CSP style-src-attr residuel (sonner, Base UI)"; labels="enhancement,priority: medium,security" },
  @{ file="049-sentry-source-maps.md"; title="[P2][infra] Sentry source maps upload CI + release tracking"; labels="enhancement,priority: medium,infra,area: api" },
  @{ file="050-web-deploy-opennext-decision.md"; title="[P2][infra] Decision deploy web OpenNext CF vs Vercel + runbook unifie"; labels="enhancement,priority: medium,infra" },
  @{ file="051-circuit-breaker-redis-revisit.md"; title="[P2][infra] Circuit breaker Redis-backed: revisiter ADR post-audit"; labels="enhancement,priority: medium,infra,area: api" },
  @{ file="052-class-capacity-do-scaling.md"; title="[P3][perf] ClassCapacityDO scaling hot class WebSocket"; labels="enhancement,priority: low,performance,area: api" },
  @{ file="053-dependabot-high-vulnerability.md"; title="[P2][security] Traiter vulnerabilite Dependabot High ouverte"; labels="bug,priority: medium,security,area: ci" }
)

$results = @()
foreach ($i in $issues) {
  $path = ".github/issue-drafts/$($i.file)"
  Write-Host "Creating: $($i.title)"
  $url = gh issue create --title $i.title --label $i.labels --body-file $path
  $results += $url
  Start-Sleep -Milliseconds 900
}

$results | Out-File -Encoding utf8 ".github/issue-drafts/created-urls-audit-2026.txt"
Write-Host "Done. $($results.Count) issues created."
