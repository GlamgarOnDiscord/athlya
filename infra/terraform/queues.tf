# Cloudflare Queues — mirrors wrangler.toml [[queues.*]] per environment.
# Import existing queues with:
#   terraform import cloudflare_queue.events '<account_id>/<queue_id>'

resource "cloudflare_queue" "events" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.events
}

resource "cloudflare_queue" "events_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.events_dlq
}

resource "cloudflare_queue" "notifications" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.notifications
}

resource "cloudflare_queue" "notifications_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.notifications_dlq
}

resource "cloudflare_queue" "rgpd" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.rgpd
}

resource "cloudflare_queue" "rgpd_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = local.queues.rgpd_dlq
}
