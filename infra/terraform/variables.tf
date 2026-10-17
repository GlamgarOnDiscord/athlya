variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers:Edit, R2:Edit, Queue:Edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for athlya.app"
  type        = string
}

variable "environment" {
  description = "Target environment: staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "cloudflare_zone_plan" {
  description = "Cloudflare plan of the zone (free, pro, business, enterprise); drives the WAF rate-limit settings it supports"
  type        = string
  default     = "pro"
  validation {
    condition     = contains(["free", "pro", "business", "enterprise"], var.cloudflare_zone_plan)
    error_message = "cloudflare_zone_plan must be free, pro, business or enterprise"
  }
}

variable "waf_bot_fight_mode" {
  description = "Enable Bot Fight Mode on the zone. Off by default: it challenges API clients and the Stripe webhook and cannot be bypassed on Free/Pro"
  type        = bool
  default     = false
}
