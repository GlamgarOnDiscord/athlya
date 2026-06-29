terraform {
  required_version = ">= 1.9.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.12"
    }
  }

  # Remote state — replace with your Terraform Cloud / S3 backend.
  # Uncomment once the backend is provisioned:
  #
  # backend "s3" {
  #   bucket = "athlya-tf-state"
  #   key    = "athlya/terraform.tfstate"
  #   region = "eu-central-1"
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
