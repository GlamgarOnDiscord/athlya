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
