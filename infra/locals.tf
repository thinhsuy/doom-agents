locals {
  name = "${var.project}-${var.env}" # e.g. agency-agents-prod

  # Two AZs — RDS subnet groups require at least two.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  public_subnet_cidrs  = [cidrsubnet(var.vpc_cidr, 8, 0), cidrsubnet(var.vpc_cidr, 8, 1)]
  private_subnet_cidrs = [cidrsubnet(var.vpc_cidr, 8, 10), cidrsubnet(var.vpc_cidr, 8, 11)]

  enable_https = var.acm_certificate_arn != ""
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
