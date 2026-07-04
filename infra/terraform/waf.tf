# WAF custom rules and Bot Fight Mode (issue #339)
#
# Blocks common scanner paths and credential-stuffing vectors before
# requests reach the Worker. All rules use the zone-scoped
# `cloudflare_ruleset` resource (provider cloudflare/cloudflare ~> 4.0).
#
# Import existing managed rulesets with:
#   terraform import cloudflare_ruleset.waf_custom <zone_id>/<ruleset_id>
#
# Bot Fight Mode is enabled via `cloudflare_bot_management` — requires
# at least the Workers Paid plan (included on Athlya's current plan).
#
# Rules:
#   1. scanner_block   — block known scanner/enumeration paths
#   2. auth_tor_block  — block Tor/datacenter IPs on auth + billing paths
#   3. rate_guard      — challenge repeated login failures by IP
#
# All rules use `block` action. Adjust to `challenge` if false-positive
# rate on legitimate traffic is unacceptable after initial rollout.
# =====================================================================

# ---- Bot Fight Mode ------------------------------------------------

resource "cloudflare_bot_management" "main" {
  zone_id    = var.cloudflare_zone_id
  enable_js  = true
  fight_mode = true
}

# ---- WAF custom ruleset --------------------------------------------

resource "cloudflare_ruleset" "waf_custom" {
  zone_id     = var.cloudflare_zone_id
  name        = "Athlya WAF custom rules (${var.environment})"
  description = "Block scanner paths, Tor exits on auth, brute-force guard"
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

  # Rule 2 — Tor/datacenter IP block on sensitive endpoints
  # Auth and billing endpoints are the primary credential-stuffing
  # surface. Blocking Tor exit nodes and known datacenter ASNs on these
  # paths eliminates anonymised brute-force traffic with minimal
  # legitimate-user impact (real members don't route through Tor).
  rules {
    action      = "block"
    expression  = <<-EOT
      (
        (
          http.request.uri.path wildcard "/v1/auth/*" or
          http.request.uri.path wildcard "/v1/billing/*"
        ) and
        (
          cf.client.bot or
          ip.src in $cf.anonymizer or
          ip.src in $cf.datacenter
        )
      )
    EOT
    description = "Block Tor/datacenter IPs on auth and billing paths"
    enabled     = true
  }

  # Rule 3 — brute-force rate guard on login
  # 5 requests per minute per IP on the login endpoint triggers a
  # managed challenge. This supplements the application-layer Redis
  # rate limiter in packages/api/src/middleware/global-limiter.ts and
  # fires before the Worker is invoked (no Neon/Redis cost incurred).
  rules {
    action = "managed_challenge"
    action_parameters {
      version = "latest"
    }
    expression  = <<-EOT
      (
        http.request.uri.path eq "/v1/auth/login" and
        http.request.method eq "POST" and
        rate(http.request.uri.path, ip.src) > 5
      )
    EOT
    description = "Challenge repeated login attempts by IP (>5 req/min)"
    enabled     = true
    ratelimit {
      characteristics        = ["ip.src"]
      period                 = 60
      requests_per_period    = 5
      mitigation_timeout     = 60
      counting_expression    = "(http.response.code ge 400)"
    }
  }
}
