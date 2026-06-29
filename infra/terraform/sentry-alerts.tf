# =====================================================================
# Sentry alert rules — issue #330, hardened by issue #415
#
# Provisions metric alerts and a release-tracking integration for the
# Athlya API production Sentry project.
#
# Alert inventory:
#   1. error_rate_spike     — failure_rate() > 1% / 5-min window
#   2. p99_latency_spike    — p99 > 2 000 ms / 5-min window
#   3. queue_lag            — queue drain age > 60 s (Cloudflare queue tail)
#   4. outbox_backlog       — outbox rows unprocessed > 500 for 10 min
#   5. readiness_failure    — /health/ready non-200 for 2 consecutive checks
#
# Provider: jianyuan/sentry v0.12 (wired in versions.tf — issue #415)
# Variables: sentry_auth_token, sentry_org, sentry_project (see below)
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

provider "sentry" {
  token = var.sentry_auth_token
}

# ---- 1. Error rate > 1% over 5 min ---------------------------------

resource "sentry_metric_alert" "error_rate_spike" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "API error rate > 1% (${var.environment})"
  dataset     = "transactions"
  query       = "!transaction.status:ok environment:${var.environment}"
  aggregate   = "failure_rate()"
  time_window = 5

  threshold_type = "above"

  trigger {
    label             = "critical"
    threshold_type    = "above"
    alert_threshold   = 0.01
    resolve_threshold = 0.005
    actions = [
      {
        type        = "email"
        target_type = "team"
      }
    ]
  }

  owner = "team:engineering"
}

# ---- 2. p99 latency > 2 000 ms over 5 min --------------------------

resource "sentry_metric_alert" "p99_latency_spike" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "API p99 latency > 2 s (${var.environment})"
  dataset     = "transactions"
  query       = "environment:${var.environment}"
  aggregate   = "p99(transaction.duration)"
  time_window = 5

  threshold_type = "above"

  trigger {
    label             = "critical"
    threshold_type    = "above"
    alert_threshold   = 2000
    resolve_threshold = 1000
    actions = [
      {
        type        = "email"
        target_type = "team"
      }
    ]
  }

  owner = "team:engineering"
}

# ---- 3. Queue drain lag > 60 s (Cloudflare queue tail) -------------
#
# Measured as the age of the oldest unacked message. If the drain
# worker is down or failing the backlog grows and this alert fires
# before outbox rows are permanently stuck.

resource "sentry_metric_alert" "queue_lag" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "Outbox queue drain lag > 60 s (${var.environment})"
  dataset     = "transactions"
  query       = "transaction:outbox.drain environment:${var.environment}"
  aggregate   = "p95(transaction.duration)"
  time_window = 5

  threshold_type = "above"

  trigger {
    label             = "critical"
    threshold_type    = "above"
    alert_threshold   = 60000
    resolve_threshold = 30000
    actions = [
      {
        type        = "email"
        target_type = "team"
      }
    ]
  }

  owner = "team:engineering"
}

# ---- 4. Outbox backlog > 500 rows for 10 min -----------------------
#
# The reconcile cron (packages/api/src/maintenance/) emits a gauge
# event `outbox.backlog_count` via Sentry custom performance metrics
# each time it runs (every 5 min). If the count stays above 500 for
# two consecutive runs something is blocking the drain.

resource "sentry_metric_alert" "outbox_backlog" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "Outbox backlog > 500 rows (${var.environment})"
  dataset     = "metrics"
  query       = "environment:${var.environment}"
  aggregate   = "max(d:custom/outbox.backlog_count@none)"
  time_window = 10

  threshold_type = "above"

  trigger {
    label             = "critical"
    threshold_type    = "above"
    alert_threshold   = 500
    resolve_threshold = 100
    actions = [
      {
        type        = "email"
        target_type = "team"
      }
    ]
  }

  owner = "team:engineering"
}

# ---- 5. /health/ready non-200 for 2 consecutive checks -------------
#
# The canary-deploy script polls /health/ready during rollout.
# If the endpoint returns non-200 twice in 10 min the API is not
# accepting traffic properly.

resource "sentry_metric_alert" "readiness_failure" {
  organization = var.sentry_org
  project      = var.sentry_project

  name        = "/health/ready non-200 (${var.environment})"
  dataset     = "transactions"
  query       = "transaction:/health/ready !transaction.status:ok environment:${var.environment}"
  aggregate   = "count()"
  time_window = 10

  threshold_type = "above"

  trigger {
    label             = "critical"
    threshold_type    = "above"
    alert_threshold   = 2
    resolve_threshold = 0
    actions = [
      {
        type        = "email"
        target_type = "team"
      }
    ]
  }

  owner = "team:engineering"
}
