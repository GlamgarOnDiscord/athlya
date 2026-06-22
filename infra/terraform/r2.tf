# R2 buckets — mirrors wrangler.toml [[r2_buckets]] per environment.
# Import existing buckets with:
#   terraform import cloudflare_r2_bucket.avatars <account_id>/<bucket_name>

resource "cloudflare_r2_bucket" "avatars" {
  account_id = var.cloudflare_account_id
  name       = local.buckets.avatars
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "exports" {
  account_id = var.cloudflare_account_id
  name       = local.buckets.exports
  location   = "WEUR"
}
