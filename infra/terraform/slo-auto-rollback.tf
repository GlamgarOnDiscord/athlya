# =====================================================================
# SLO auto-rollback trigger — CN.7.3 (issue #632)
#
# Two production-only monitors (5xx share, p99 latency) fire after ten
# consecutive breaching minutes and call a custom webhook that dispatches
# .github/workflows/slo-rollback.yml. The workflow never trusts this
# call: it re-queries Axiom with its own read-only token and runs every
# rollback guard (scripts/slo-rollback.mjs). Thresholds match
# SLO_ROLLBACK in that script (asserted by slo-rollback.test.mjs).
#
# Off by default: nothing is created until slo_auto_rollback_enabled is
# true AND environment is "production". The GitHub token lives only in
# the Axiom notifier (sensitive header); it must be a fine-grained PAT
# limited to this repository with "Actions: write" and nothing else.
# Runbook: docs/runbooks/automatic-rollback.md
# =====================================================================

variable "slo_auto_rollback_enabled" {
  description = "Create the SLO auto-rollback monitors and webhook notifier (production only)"
  type        = bool
  default     = false
}

variable "slo_auto_rollback_github_token" {
  description = "Fine-grained GitHub PAT (this repository only, Actions: write) the Axiom notifier uses to dispatch slo-rollback.yml"
  type        = string
  sensitive   = true
  default     = ""
  validation {
    condition     = !var.slo_auto_rollback_enabled || length(trimspace(var.slo_auto_rollback_github_token)) > 0
    error_message = "slo_auto_rollback_github_token must be set when slo_auto_rollback_enabled is true."
  }
}

variable "slo_auto_rollback_repository" {
  description = "owner/repo whose slo-rollback.yml workflow the notifier dispatches"
  type        = string
  default     = "GlamgarOnDiscord/athlya"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.slo_auto_rollback_repository))
    error_message = "slo_auto_rollback_repository must be owner/repo."
  }
}

locals {
  slo_auto_rollback = var.slo_auto_rollback_enabled && var.environment == "production"

  # Same span filter and sampling correction as api_5xx_rate; one-minute
  # bins with at least 20 estimated requests, like the workflow re-check.
  slo_auto_rollback_base = <<-APL
    ${local.axiom_spans}
    | where not(name contains " /health")
    | summarize total = count(), errors = countif(['status.code'] == "ERROR"), p99_ms = percentile(duration, 99) / 1ms by bin(_time, 1m)
    | extend requests = todouble(errors) + todouble(total - errors) / ${local.otel_sample_rate}
    | where requests >= 20
  APL

  slo_auto_rollback_monitors = {
    error_rate = {
      name        = "SLO auto-rollback: 5xx > 2% for 10 min"
      description = "Dispatches slo-rollback.yml (CN.7.3, docs/runbooks/automatic-rollback.md)"
      apl_query   = "${local.slo_auto_rollback_base}| extend rate_pct = 100.0 * todouble(errors) / requests\n| project _time, rate_pct\n"
      threshold   = 2
    }
    latency_p99 = {
      name        = "SLO auto-rollback: p99 > 2000 ms for 10 min"
      description = "Dispatches slo-rollback.yml (CN.7.3, docs/runbooks/automatic-rollback.md)"
      apl_query   = "${local.slo_auto_rollback_base}| project _time, p99_ms\n"
      threshold   = 2000
    }
  }
}

resource "axiom_notifier" "slo_auto_rollback" {
  count = local.slo_auto_rollback ? 1 : 0

  name = "[${var.environment}] GitHub slo-rollback.yml dispatch"
  properties = {
    custom_webhook = {
      url = "https://api.github.com/repos/${var.slo_auto_rollback_repository}/actions/workflows/slo-rollback.yml/dispatches"
      headers = {
        Accept                 = "application/vnd.github+json"
        Authorization          = "Bearer ${var.slo_auto_rollback_github_token}"
        "Content-Type"         = "application/json"
        "X-GitHub-Api-Version" = "2022-11-28"
      }
      body = jsonencode({
        ref    = "master"
        inputs = { reason = "axiom SLO auto-rollback monitor" }
      })
    }
  }
}

resource "axiom_monitor" "slo_auto_rollback" {
  for_each = local.slo_auto_rollback ? local.slo_auto_rollback_monitors : {}

  name                = "[${var.environment}] ${each.value.name}"
  description         = each.value.description
  type                = "Threshold"
  apl_query           = each.value.apl_query
  operator            = "Above"
  threshold           = each.value.threshold
  interval_minutes    = 1
  range_minutes       = 1
  trigger_from_n_runs = 10
  alert_on_no_data    = false
  notify_by_group     = false
  notifier_ids        = concat([axiom_notifier.slo_auto_rollback[0].id], var.axiom_notifier_ids)
}
