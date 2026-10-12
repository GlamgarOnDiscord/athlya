terraform {
  required_version = ">= 1.9.0"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5 is a breaking rewrite (tf-migrate + reviewed plans) — tracked in #405.
      version = "~> 4.52"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.15"
    }
  }

  # Remote state with locking — HCP Terraform (issue #405).
  #
  # The organisation comes from TF_CLOUD_ORGANIZATION and the workspace
  # from TF_WORKSPACE (athlya-staging / athlya-production), both set by
  # .github/workflows/terraform.yml; TF_TOKEN_app_terraform_io
  # authenticates. Workspaces use execution mode "Local" (CI runs plan
  # and apply). There is deliberately no local-state fallback: without a
  # backend, `terraform init` fails instead of producing state on a
  # throwaway runner. Credential-free checks use `init -backend=false`.
  cloud {
    workspaces {
      tags = ["athlya"]
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
