output "app_url" {
  description = "Public URL of the app (open this in a browser)."
  value       = local.enable_https ? "https://${aws_lb.app.dns_name}" : "http://${aws_lb.app.dns_name}"
}

output "alb_dns_name" {
  value = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  description = "Build & push the app image here (see README)."
  value       = aws_ecr_repository.app.repository_url
}

output "rds_endpoint" {
  description = "Postgres host:port (private — reachable only from the ECS task)."
  value       = "${aws_db_instance.main.address}:${aws_db_instance.main.port}"
}

output "s3_bucket" {
  value = aws_s3_bucket.app.bucket
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service" {
  value = aws_ecs_service.app.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "ssm_secret_names" {
  description = "SecureString params you must set the REAL values for (aws ssm put-parameter --overwrite)."
  value       = [for k in keys(local.user_secrets) : "${local.ssm_prefix}/${k}"]
}

output "github_deploy_role_arn" {
  description = "Set this as the GitHub repo secret AWS_DEPLOY_ROLE_ARN for the deploy workflow."
  value       = aws_iam_role.github_deploy.arn
}

output "ecs_container_name" {
  description = "Container name the deploy workflow overrides to run migrations."
  value       = var.project
}
