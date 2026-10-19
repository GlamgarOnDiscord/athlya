# =====================================================================
# Axiom SLO monitors — issue #415
#
# The production-critical SLO alerts as code, so they are reproducible
# per environment instead of hand-made in the Axiom UI. Definitions and
# thresholds follow docs/operations/axiom-alerts.md (A1–A5, A16) and the
# SLOs in docs/operations/slos.md. The other catalogue entries (security,
# config, capacity, CSP — A6–A15, A17, A18) stay manual for now.
#
# Signal contract (monitor → emitted signal → dataset):
#   api_5xx_rate          → OTLP spans, `status.code` = ERROR (>= 500)       → spans
#   auth_login_p95        → OTLP span `auth.login` (traceOperation)          → spans
#   reservations_book_p99 → OTLP span `reservations.book` (traceOperation)   → spans
#   queue_lag             → `outbox.backlog` log line, `ageMs` (every tick)  → logs
#   outbox_backlog        → `outbox.backlog` log line, `pending`             → logs
#   dlq_depth             → `[dlq] drain cycle complete`, `totalPending`     → logs
#
# Spans come from packages/api/src/middleware/otel.ts (OTLP/HTTP JSON);
# log lines from packages/api/src/events/drain-scheduled.ts and
# drain-dlq.ts, emitted through logEvent() (packages/api/src/logging.ts):
# one console argument per line, a flat object `{ message, ...fields }`.
# The log queries read that object as the Axiom event: the label in
# `message`, the metric fields at the top level, never under a wrapper
# (`fields`, `attributes`, `data`, `Logs[].Message`). The field contract
# and the post-apply check are in docs/runbooks/axiom-alerts-provision.md.
# packages/api/src/__tests__/axiom-log-monitors.contract.test.ts parses
# these queries and checks every referenced field against the emitters;
# scripts/__tests__/axiom-monitors.test.mjs keeps every SLO covered and
# every variable fail-closed (no defaults).
#
# Datasets are per environment (GitHub environment variables): the
# queries do not filter by environment, so staging and production must
# never share a dataset.
#
# Provider: axiomhq/axiom ~> 1.7. The API token needs "Monitors"
# read/write plus query access to both datasets; notifiers are referenced
# by id, not managed here.
# Import a monitor already created in the UI with:
#   terraform import 'axiom_monitor.slo["queue_lag"]' <monitor-id>
# Variables: axiom_api_token, axiom_spans_dataset, axiom_logs_dataset,
#            axiom_notifier_ids, axiom_page_notifier_ids
# =====================================================================

variable "axiom_api_token" {
  description = "Axiom advanced API token allowed to manage monitors and query the datasets. Mark sensitive."
  type        = string
  sensitive   = true
  validation {
    condition     = length(trimspace(var.axiom_api_token)) > 0
    error_message = "axiom_api_token must be set: SLO monitors cannot be provisioned without it."
  }
}

variable "axiom_spans_dataset" {
  description = "Axiom dataset receiving this environment's Worker OTLP spans (X-Axiom-Dataset of OTEL_EXPORTER_OTLP_HEADERS); never shared between environments"
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.axiom_spans_dataset))
    error_message = "axiom_spans_dataset must be a dataset name (letters, digits, '.', '_' or '-')."
  }
}

variable "axiom_logs_dataset" {
  description = "Axiom dataset receiving this environment's Worker log lines (outbox.backlog, [dlq] drain cycle complete); never shared between environments"
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.axiom_logs_dataset))
    error_message = "axiom_logs_dataset must be a dataset name (letters, digits, '.', '_' or '-')."
  }
}

variable "axiom_notifier_ids" {
  description = "Ids of the Axiom notifiers every SLO monitor notifies (Slack #ops-athlya-alerts)"
  type        = list(string)
  validation {
    condition     = length(var.axiom_notifier_ids) > 0 && alltrue([for id in var.axiom_notifier_ids : length(trimspace(id)) > 0])
    error_message = "axiom_notifier_ids must list at least one notifier: a monitor nobody hears is not an alert."
  }
}

variable "axiom_page_notifier_ids" {
  description = "Ids of the paging notifiers (PagerDuty) added to the monitors that page on-call; [] is an explicit choice not to page"
  type        = list(string)
  validation {
    condition     = alltrue([for id in var.axiom_page_notifier_ids : length(trimspace(id)) > 0])
    error_message = "axiom_page_notifier_ids must not contain empty ids."
  }
}

provider "axiom" {
  api_token = var.axiom_api_token
}

locals {
  axiom_spans = "['${var.axiom_spans_dataset}']"
  axiom_logs  = "['${var.axiom_logs_dataset}']"

  # OTEL_SAMPLE_RATE per environment — keep in sync with
  # packages/api/wrangler.toml (asserted by axiom-monitors.test.mjs).
  # Non-5xx spans are exported at this rate, 5xx spans always.
  otel_sample_rate = {
    staging    = 0.5
    production = 0.1
  }[var.environment]

  # Every query returns one numeric column per time bin, which the
  # Threshold monitor compares against `threshold`. `page` adds the paging
  # notifiers (routes from docs/runbooks/axiom-alerts-provision.md).
  axiom_slo_monitors = {
    # A1 / S3 — 5xx share of requests. Non-5xx spans are scaled back up by
    # 1 / OTEL_SAMPLE_RATE because only 5xx spans are always exported.
    # /health* probes are sampled at a different rate (1 %), so they are
    # excluded; their span name is "<METHOD> /health…" (otel.ts).
    api_5xx_rate = {
      name                = "API 5xx rate > 1% / 5 min"
      description         = "A1 / SLO S3 — share of 5xx responses (docs/operations/axiom-alerts.md § A1)"
      apl_query           = <<-APL
        ${local.axiom_spans}
        | where not(name contains " /health")
        | summarize total = count(), errors = countif(['status.code'] == "ERROR") by bin_auto(_time)
        | extend requests = todouble(errors) + todouble(total - errors) / ${local.otel_sample_rate}
        | extend rate_pct = 100.0 * todouble(errors) / requests
        | project _time, rate_pct
      APL
      threshold           = 1
      interval_minutes    = 5
      range_minutes       = 5
      trigger_from_n_runs = 1
      alert_on_no_data    = false
      page                = false
    }

    # A2 / S2 — ignores windows with 10 samples or fewer (low traffic).
    auth_login_p95 = {
      name                = "auth.login p95 > 200 ms"
      description         = "A2 / SLO S2 — login latency (docs/operations/axiom-alerts.md § A2)"
      apl_query           = <<-APL
        ${local.axiom_spans}
        | where name == "auth.login"
        | summarize p95_ms = percentile(duration, 95) / 1ms, samples = count() by bin_auto(_time)
        | where samples > 10
        | project _time, p95_ms
      APL
      threshold           = 200
      interval_minutes    = 5
      range_minutes       = 5
      trigger_from_n_runs = 1
      alert_on_no_data    = false
      page                = false
    }

    # A3 / S1 — booking is the contention-critical path; pages on-call.
    reservations_book_p99 = {
      name                = "reservations.book p99 > 500 ms"
      description         = "A3 / SLO S1 — booking latency (docs/operations/axiom-alerts.md § A3)"
      apl_query           = <<-APL
        ${local.axiom_spans}
        | where name == "reservations.book"
        | summarize p99_ms = percentile(duration, 99) / 1ms, samples = count() by bin_auto(_time)
        | where samples > 5
        | project _time, p99_ms
      APL
      threshold           = 500
      interval_minutes    = 5
      range_minutes       = 5
      trigger_from_n_runs = 1
      alert_on_no_data    = false
      page                = true
    }

    # A4 / S4 — age of the oldest pending outbox event. The drain cron logs
    # outbox.backlog every minute, so no data means the cron or the log
    # pipeline stopped: that alerts too.
    queue_lag = {
      name                = "Queue lag (oldest outbox event) > 60 s"
      description         = "A4 / SLO S4 — event delivery lag (docs/operations/slos.md § S4)"
      apl_query           = <<-APL
        ${local.axiom_logs}
        | where ['message'] == "outbox.backlog"
        | summarize max_age_ms = max(tolong(['ageMs'])) by bin_auto(_time)
        | project _time, max_age_ms
      APL
      threshold           = 60000
      interval_minutes    = 5
      range_minutes       = 5
      trigger_from_n_runs = 1
      alert_on_no_data    = true
      page                = false
    }

    # A16 — the backlog must stay above 500 for five consecutive one-minute
    # runs (each over the last two cron ticks), so one partial window or a
    # single spike cannot fire it.
    outbox_backlog = {
      name                = "Outbox backlog > 500 for 5 min"
      description         = "A16 — drain falling behind (docs/runbooks/outbox-ops.md)"
      apl_query           = <<-APL
        ${local.axiom_logs}
        | where ['message'] == "outbox.backlog"
        | summarize min_pending = min(toint(['pending'])) by bin_auto(_time)
        | project _time, min_pending
      APL
      threshold           = 500
      interval_minutes    = 1
      range_minutes       = 2
      trigger_from_n_runs = 5
      alert_on_no_data    = true
      page                = false
    }

    # A5 / S6 — the DLQ consumer logs the pending set after every batch; it
    # is silent while the DLQ receives nothing, so no data is healthy. Each
    # new DLQ entry also raises a Sentry error (drain-dlq.ts alertOnDlqEntry).
    dlq_depth = {
      name                = "DLQ pending > 100"
      description         = "A5 — dead-letter backlog; inspect GET /admin/dlq/stats (docs/runbooks/event-bus.md)"
      apl_query           = <<-APL
        ${local.axiom_logs}
        | where ['message'] == "[dlq] drain cycle complete"
        | summarize max_pending = max(toint(['totalPending'])) by bin_auto(_time)
        | project _time, max_pending
      APL
      threshold           = 100
      interval_minutes    = 15
      range_minutes       = 15
      trigger_from_n_runs = 1
      alert_on_no_data    = false
      page                = false
    }
  }
}

resource "axiom_monitor" "slo" {
  for_each = local.axiom_slo_monitors

  name                = "[${var.environment}] ${each.value.name}"
  description         = each.value.description
  type                = "Threshold"
  apl_query           = each.value.apl_query
  operator            = "Above"
  threshold           = each.value.threshold
  interval_minutes    = each.value.interval_minutes
  range_minutes       = each.value.range_minutes
  trigger_from_n_runs = each.value.trigger_from_n_runs
  alert_on_no_data    = each.value.alert_on_no_data
  notify_by_group     = false
  notifier_ids        = each.value.page ? concat(var.axiom_notifier_ids, var.axiom_page_notifier_ids) : var.axiom_notifier_ids
}
