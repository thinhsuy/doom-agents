# Secrets live in SSM Parameter Store (SecureString) — free tier, and the ECS task injects
# them as env at runtime so they never sit in the task definition or image.
#
# Two kinds:
#  1. TF-managed  — the DB password and the session-signing secret are generated here.
#  2. User-supplied — API key + the 3 owner login passwords: created as placeholders with
#     `ignore_changes = [value]`, so you set the REAL values out-of-band (keeping them out
#     of Terraform state / tfvars):
#        aws ssm put-parameter --overwrite --type SecureString \
#          --name /agency-agents-prod/OPENAI_API_KEY --value 'sk-...'

locals {
  ssm_prefix = "/${local.name}"

  # Secret name -> the placeholder to create (you overwrite these via the CLI).
  user_secrets = {
    OPENAI_API_KEY    = "CHANGE_ME"
    AUTH_CEO_PASSWORD = "CHANGE_ME"
    AUTH_CTO_PASSWORD = "CHANGE_ME"
    AUTH_COO_PASSWORD = "CHANGE_ME"
    AUTH_CIO_PASSWORD = "CHANGE_ME"
  }
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "pgpassword" {
  name  = "${local.ssm_prefix}/PGPASSWORD"
  type  = "SecureString"
  value = random_password.db.result
  tags  = { Name = "${local.name}-pgpassword" }
}

resource "aws_ssm_parameter" "auth_secret" {
  name  = "${local.ssm_prefix}/AUTH_SECRET"
  type  = "SecureString"
  value = random_password.session_secret.result
  tags  = { Name = "${local.name}-auth-secret" }
}

resource "aws_ssm_parameter" "user" {
  for_each = local.user_secrets
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "SecureString"
  value    = each.value
  tags     = { Name = "${local.name}-${lower(each.key)}" }

  lifecycle {
    ignore_changes = [value] # you set the real value with `aws ssm put-parameter --overwrite`
  }
}
