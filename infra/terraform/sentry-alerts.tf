# =====================================================================
# Sentry alert rules — issue #330
#
# Provisions metric alerts that fire when the error rate exceeds 1%
# over a 5-minute window on the production project.
#
# Provider: jianyuan/sentry (https://registry.terraform.io/providers/
#   jianyuan/sentry)
# Add to versions.tf required_providers once a Sentry auth token is
# available:
#
#   sentry = {
#     source  = "jianyuan/sentry"
#     version = "~> 0.12"
#   }
#
# Then add to terraform.tfvars.example and variables.tf:
#   sentry_auth_token = ""   # https://sentry.io/settings/account/api/auth-tokens/
#   sentry_org        = ""   # e.g. "athlya"
#   sentry_project    = ""   # e.g. "athlya-api"
#
# Provider variables are defined below as placeholders. Uncomment the
# provider block in versions.tf and set the variables before applying.
#
# Apply:
#   terraform init
#   terraform apply -target=sentry_metric_alert.error_rate_spike
# =====================================================================

# ---- Variables (add to variables.tf when wiring the provider) --------

variable "sentry_auth_token" {
  description = "Sentry API auth token (Settings → Auth Tokens). Mark sensitive."
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_org" {
  description = "Sentry organisation slug (e.g. 'athlya')"
  type        = string
  default     = ""
}

variable "sentry_project" {
  description = "Sentry project slug (e.g. 'athlya-api')"
  type        = string
  default     = ""
}

# ---- Alert: error rate > 1% over 5 min (production) -----------------
#
# Uncomment the resource blocks below once the Sentry provider is wired.
# The resource type `sentry_metric_alert` maps 1:1 to a Sentry metric
# alert rule (Issues → Alerts → Metric Alerts).
#
# resource "sentry_metric_alert" "error_rate_spike" {
#   organization = var.sentry_org
#   project      = var.sentry_project
#
#   name        = "API error rate > 1% (${var.environment})"
#   dataset     = "transactions"
#   query       = "!transaction.status:ok environment:${var.environment}"
#   aggregate   = "failure_rate()"
#   time_window = 5
#
#   threshold_type = "above"
#
#   trigger {
#     label            = "critical"
#     threshold_type   = "above"
#     alert_threshold  = 0.01   # 1%
#     resolve_threshold = 0.005 # auto-resolve at 0.5%
#     actions = [
#       {
#         type       = "email"
#         target_type = "team"
#       }
#     ]
#   }
#
#   # Prevents alert storms during planned maintenance / deploys.
#   # Set SENTRY_IGNORE_WINDOW in the environment when running a deploy.
#   owner = "team:engineering"
# }
#
# resource "sentry_metric_alert" "p99_latency_spike" {
#   organization = var.sentry_org
#   project      = var.sentry_project
#
#   name        = "API p99 latency > 2 s (${var.environment})"
#   dataset     = "transactions"
#   query       = "environment:${var.environment}"
#   aggregate   = "p99(transaction.duration)"
#   time_window = 5
#
#   threshold_type = "above"
#
#   trigger {
#     label            = "critical"
#     threshold_type   = "above"
#     alert_threshold  = 2000    # 2000 ms
#     resolve_threshold = 1000
#   }
#
#   owner = "team:engineering"
# }
