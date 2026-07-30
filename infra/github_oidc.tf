# GitHub Actions → AWS via OIDC. The deploy workflow (.github/workflows/deploy.yml) assumes
# this role with a short-lived token — no long-lived access keys stored in GitHub.
# Output `github_deploy_role_arn` → set it as the repo secret AWS_DEPLOY_ROLE_ARN.

# The account can hold only ONE provider for this URL. If you already have one, set
# create_oidc_provider=false and this stack reuses it (by conventional ARN) instead.
data "tls_certificate" "github" {
  count = var.create_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github[0].certificates[0].sha1_fingerprint]
  tags            = { Name = "${local.name}-github-oidc" }
}

locals {
  github_oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

# Trust: only this repo, only the main branch, only for AWS STS.
data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
  tags               = { Name = "${local.name}-github-deploy" }
}

# Least-privilege for the pipeline: push the image, register a task def, run the one-off
# migration task, roll the service, and read status/ALB DNS for the health check.
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPushPull"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  # ECS task-definition + run-task + update-service actions do not support resource-level
  # scoping cleanly (revisions/ids vary), so these are account-wide but action-limited.
  statement {
    sid = "Ecs"
    actions = [
      "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition",
      "ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks",
      "ecs:UpdateService", "ecs:DescribeServices",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "ElbRead"
    actions   = ["elasticloadbalancing:DescribeLoadBalancers"]
    resources = ["*"]
  }
  # RegisterTaskDefinition/RunTask must hand ECS the execution + task roles.
  statement {
    sid       = "PassRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${local.name}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
