# WAF custom rules, login rate limit and Bot Fight Mode (issue #339)
#
# Blocks common scanner paths and credential-stuffing vectors before
# requests reach the Worker (provider cloudflare/cloudflare ~> 4.0).
#
# Cloudflare evaluates each concern in its own ruleset phase:
#   - http_request_firewall_custom — scanner block + Tor block
#   - http_ratelimit               — login brute-force guard
# A `ratelimit {}` block or `rate()` expression is invalid inside the
# custom-firewall phase, which is why the guard lives in its own ruleset.
#
# Plan-dependent settings (see var.cloudflare_zone_plan):
#   - Free: rate-limit period is capped at 10 s.
#   - Free/Pro/Business: a challenge action requires mitigation_timeout = 0
#     (request throttling); only Enterprise can set a challenge duration.
#   - Pro: period up to 60 s, no custom counting expression.
#   - Business/Enterprise: counting expression on response codes, so only
#     failed logins count towards the limit.
#   - Managed IP lists ($cf.anonymizer, $cf.vpn, …) need Enterprise, so the
#     Tor block uses `ip.src.continent eq "T1"` (all plans).
#
# Import existing rulesets with:
#   terraform import cloudflare_ruleset.waf_custom zone/<zone_id>/<ruleset_id>
#   terraform import cloudflare_ruleset.login_ratelimit zone/<zone_id>/<ruleset_id>
# =====================================================================

locals {
  waf_rate_limit_period          = var.cloudflare_zone_plan == "free" ? 10 : 60
  waf_rate_limit_counts_failures = contains(["business", "enterprise"], var.cloudflare_zone_plan)
  # Without a counting expression every attempt counts, so allow a little
  # more headroom for typos and shared IPs (gyms, offices).
  waf_rate_limit_requests_threshold = local.waf_rate_limit_counts_failures ? 5 : 10
  # With a challenge action, Free/Pro/Business must use request throttling
  # (mitigation_timeout = 0); only Enterprise may set a duration.
  waf_rate_limit_mitigation_timeout = var.cloudflare_zone_plan == "enterprise" ? local.waf_rate_limit_period : 0
}

# ---- Bot Fight Mode ------------------------------------------------
#
# Bot Fight Mode challenges automated clients zone-wide and cannot be
# bypassed by custom rules on Free/Pro. The API zone serves the mobile
# app, server-to-server callers and the Stripe webhook, all of which
# would be challenged, so it stays off unless explicitly enabled.

resource "cloudflare_bot_management" "main" {
  zone_id    = var.cloudflare_zone_id
  enable_js  = var.waf_bot_fight_mode
  fight_mode = var.waf_bot_fight_mode
}

# ---- WAF custom ruleset --------------------------------------------

resource "cloudflare_ruleset" "waf_custom" {
  zone_id     = var.cloudflare_zone_id
  name        = "Athlya WAF custom rules (${var.environment})"
  description = "Block scanner paths and Tor exits on auth and billing"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # Rule 1 — scanner path block
  # Blocks requests to common enumeration/probe paths that would never
  # appear in a legitimate Athlya client request.
  rules {
    action      = "block"
    expression  = <<-EOT
      (
        http.request.uri.path contains "/.env"         or
        http.request.uri.path contains "/.git/"        or
        http.request.uri.path contains "/wp-login"     or
        http.request.uri.path contains "/wp-admin"     or
        http.request.uri.path contains "/phpMyAdmin"   or
        http.request.uri.path contains "/phpmyadmin"   or
        http.request.uri.path contains "/admin.php"    or
        http.request.uri.path contains "/xmlrpc.php"   or
        http.request.uri.path contains "/.well-known/acme-challenge/../" or
        http.request.uri.path contains "/etc/passwd"   or
        http.request.uri.path contains "/proc/self"
      )
    EOT
    description = "Block scanner/enumeration paths"
    enabled     = true
  }

  # Rule 2 — Tor exit block on credential and payment endpoints
  # Auth and billing endpoints are the primary credential-stuffing
  # surface. Real members don't route through Tor. The Stripe webhook is
  # excluded: it is called server-to-server and verified by signature.
  rules {
    action      = "block"
    expression  = <<-EOT
      (
        (
          starts_with(http.request.uri.path, "/v1/auth/") or
          (
            starts_with(http.request.uri.path, "/v1/billing/") and
            http.request.uri.path ne "/v1/billing/webhook"
          )
        ) and
        ip.src.continent eq "T1"
      )
    EOT
    description = "Block Tor exit nodes on auth and billing paths (webhook excluded)"
    enabled     = true
  }
}

# ---- Login rate limit ------------------------------------------------
#
# Supplements the application-layer Redis limiter
# (packages/api/src/middleware/global-limiter.ts) and fires before the
# Worker is invoked, so a brute-force burst costs no Neon/Redis calls.

resource "cloudflare_ruleset" "login_ratelimit" {
  zone_id     = var.cloudflare_zone_id
  name        = "Athlya login rate limit (${var.environment})"
  description = "Challenge repeated login attempts per IP"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action      = "managed_challenge"
    expression  = "(http.request.uri.path eq \"/v1/auth/login\" and http.request.method eq \"POST\")"
    description = "Challenge repeated login attempts by IP"
    enabled     = true

    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = local.waf_rate_limit_period
      requests_per_period = local.waf_rate_limit_requests_threshold
      mitigation_timeout  = local.waf_rate_limit_mitigation_timeout
      # Business+ only: count failed logins, not every attempt.
      counting_expression = local.waf_rate_limit_counts_failures ? "(http.request.uri.path eq \"/v1/auth/login\" and http.response.code ge 400)" : null
    }
  }
}
