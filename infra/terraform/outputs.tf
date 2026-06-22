output "queue_ids" {
  description = "Cloudflare Queue IDs (needed for wrangler.toml queue consumer bindings)"
  value = {
    events            = cloudflare_queue.events.id
    events_dlq        = cloudflare_queue.events_dlq.id
    notifications     = cloudflare_queue.notifications.id
    notifications_dlq = cloudflare_queue.notifications_dlq.id
    rgpd              = cloudflare_queue.rgpd.id
    rgpd_dlq          = cloudflare_queue.rgpd_dlq.id
  }
}

output "r2_bucket_names" {
  description = "R2 bucket names for wrangler.toml [[r2_buckets]] bindings"
  value = {
    avatars = cloudflare_r2_bucket.avatars.name
    exports = cloudflare_r2_bucket.exports.name
  }
}
