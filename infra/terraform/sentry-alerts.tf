# =====================================================================
# Sentry alert rules — issue #330, signal contract fixed by issue #415
#
# Every alert here must query a signal the runtime actually sends to
# Sentry. The Worker's minimal client (packages/api/src/sentry.ts) emits
# **error events only** — no transactions, no custom metrics — tagged
# with `environment` and `release = VERSION` (the deployed commit SHA),
# without user context — so no alert may rely on `user`.
#
# Per-release error budgets are enforced at deploy time by the canary
# gate (scripts/canary-error-budget.mjs), not by a standing alert.
#
# Signal contract (alert → emitted signal → backend):
#   error_count_spike   → captured exceptions          → Sentry (this file)
#   5xx rate, latency   → OTLP spans                   → axiom-monitors.tf (A1/A2/A3)
#   queue lag, DLQ      → `outbox.backlog`, `[dlq] …`  → axiom-monitors.tf (A4/A5)
#   outbox backlog      → `outbox.backlog` log line    → axiom-monitors.tf (A16)
#   /health/ready       → external probe               → synthetics.yml
#
# scripts/__tests__/sentry-alerts.test.mjs fails if an alert here queries
# a dataset the runtime does not emit (transactions, custom metrics).
#
# Provider: jianyuan/sentry ~> 0.15 (threshold_type is numeric: 0 = above)
#
# Import an existing alert rule (IDs are in the Sentry rule URL) with:
#   terraform import sentry_metric_alert.error_count_spike <org-slug>/<project-slug>/<alert-rule-id>
# Variables: sentry_auth_token, sentry_org, sentry_project, sentry_alert_team
# =====================================================================

variable "sentry_auth_token" {
  description = "Sentry API auth token (Settings > Auth Tokens). Mark sensitive."
  type        = string
  sensitive   = true
}

variable "sentry_org" {
  description = "Sentry organisation slug (e.g. 'athlya')"
  type        = string
}

variable "sentry_project" {
  description = "Sentry project slug (e.g. 'athlya-api')"
  type        = string
}

variable "sentry_alert_team_id" {
  description = "Numeric id of the Sentry team notified by email (Settings > Teams)"
  type        = string
}

provider "sentry" {
  token = var.sentry_auth_token
}

locals {
  # jianyuan/sentry encodes the comparison as a number: 0 = above, 1 = below.
  sentry_threshold_above = 0
}

# ---- 1. Error volume spike -----------------------------------------
#
# More than 25 captured exceptions in 5 minutes for the environment —
# the Sentry-side twin of Axiom A1 (5xx rate), useful because Sentry
# groups the errors by issue and resolves stack frames via source maps.

resource "sentry_metric_alert" "error_count_spike" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "API errors > 25 / 5 min (${var.environment})"
  dataset     = "events"
  event_types = ["error"]
  environment = var.environment
  query       = ""
  aggregate   = "count()"
  time_window = 5

  threshold_type = local.sentry_threshold_above

  trigger {
    label             = "critical"
    threshold_type    = local.sentry_threshold_above
    alert_threshold   = 25
    resolve_threshold = 5

    action {
      type              = "email"
      target_type       = "team"
      target_identifier = var.sentry_alert_team_id
    }
  }
}
