terraform {
  required_version = ">= 1.9.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.15"
    }
  }

  # Remote state with locking — HCP Terraform (Terraform Cloud) free tier.
  # Set TF_TOKEN_app_terraform_io in GitHub Environment secrets.
  # Replace <org> with your HCP Terraform organisation slug.
  #
  # Create TWO workspaces: athlya-staging and athlya-production.
  # CI sets TF_WORKSPACE=athlya-<environment> to target the correct one.
  # Both workspaces use execution mode = Local (Terraform runs in CI).
  #
  # Uncomment once TF_TOKEN_app_terraform_io is set (issue #405):
  #
  # cloud {
  #   organization = "<org>"
  #   workspaces {
  #     tags = ["athlya"]
  #   }
  # }
  #
  # Alternative — S3 backend with DynamoDB locking (one key per env):
  #
  # backend "s3" {
  #   bucket                = "athlya-tf-state"
  #   key                   = "athlya/${TF_VAR_environment}/terraform.tfstate"
  #   region                = "eu-central-1"
  #   dynamodb_table        = "athlya-tf-locks"
  #   encrypt               = true
  #   workspace_key_prefix  = "env"
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
