locals {
  is_production = var.environment == "production"

  # Resource naming: staging uses "-staging" suffix, production uses bare names.
  env_suffix = local.is_production ? "" : "-${var.environment}"

  # Queue names per environment (mirrors wrangler.toml [[queues.*]])
  queues = {
    events        = "athlya-events${local.env_suffix}"
    events_dlq    = "athlya-events${local.env_suffix}-dlq"
    notifications = "athlya-events-notifications${local.env_suffix}"
    notifications_dlq = "athlya-events-notifications${local.env_suffix}-dlq"
    rgpd          = "athlya-events-rgpd${local.env_suffix}"
    rgpd_dlq      = "athlya-events-rgpd${local.env_suffix}-dlq"
  }

  # R2 bucket names per environment
  buckets = {
    avatars = "athlya-avatars-${var.environment}"
    exports = "athlya-exports-${var.environment}"
  }

  # DNS routes per environment
  worker_route = local.is_production ? "api.athlya.app/*" : "staging.api.athlya.app/*"
}
