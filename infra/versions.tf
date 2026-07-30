terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region

  # Every resource is tagged so the whole stack is identifiable as "agency-agents".
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Env       = var.env
    }
  }
}
