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

  # Remote state with locking — HCP Terraform (Terraform Cloud) free tier.
  # Set TF_TOKEN_app_terraform_io in GitHub Environment secrets.
  # Replace <org> and <workspace> with your HCP Terraform org/workspace name.
  #
  # Uncomment once TF_TOKEN_app_terraform_io is set (issue #405):
  #
  # cloud {
  #   organization = "<org>"
  #   workspaces {
  #     name = "athlya-production"
  #   }
  # }
  #
  # Alternative — S3 backend with DynamoDB locking:
  #
  # backend "s3" {
  #   bucket         = "athlya-tf-state"
  #   key            = "athlya/terraform.tfstate"
  #   region         = "eu-central-1"
  #   dynamodb_table = "athlya-tf-locks"
  #   encrypt        = true
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
