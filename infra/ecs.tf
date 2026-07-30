resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
  tags              = { Name = "${local.name}-logs" }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled" # keep costs down; enable for deeper metrics
  }
  tags = { Name = local.name }
}

# The single app container: FastAPI serving REST + WebSocket + the built FE.
resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = var.project # container is named "agency-agents"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "PGHOST", value = aws_db_instance.main.address },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = var.db_name },
      { name = "PGUSER", value = var.db_username },
      { name = "AWS_REGION", value = var.region },
      { name = "BEDROCK_REGION", value = var.region },
      { name = "AWS_S3_BUCKET", value = aws_s3_bucket.app.bucket },
      { name = "DEFAULT_PROVIDER", value = "claude" },
      { name = "DEFAULT_MODEL", value = "haiku" },
      { name = "MAX_DAILY_USD", value = "5" },
    ]

    # Injected from SSM SecureString at start — never stored in the task def/image.
    secrets = [
      { name = "PGPASSWORD", valueFrom = aws_ssm_parameter.pgpassword.arn },
      { name = "AUTH_SECRET", valueFrom = aws_ssm_parameter.auth_secret.arn },
      { name = "OPENAI_API_KEY", valueFrom = aws_ssm_parameter.user["OPENAI_API_KEY"].arn },
      { name = "AUTH_CEO_PASSWORD", valueFrom = aws_ssm_parameter.user["AUTH_CEO_PASSWORD"].arn },
      { name = "AUTH_CTO_PASSWORD", valueFrom = aws_ssm_parameter.user["AUTH_CTO_PASSWORD"].arn },
      { name = "AUTH_COO_PASSWORD", valueFrom = aws_ssm_parameter.user["AUTH_COO_PASSWORD"].arn },
      { name = "AUTH_CIO_PASSWORD", valueFrom = aws_ssm_parameter.user["AUTH_CIO_PASSWORD"].arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])

  tags = { Name = local.name }
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Public subnets + public IP so the task pulls the image and reaches OpenAI/Bedrock
  # without a (paid) NAT gateway.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.project
    container_port   = var.container_port
  }

  # Give a new task time to boot before the ALB starts health-checking it.
  health_check_grace_period_seconds = 60

  depends_on = [aws_lb_listener.http]

  tags = { Name = local.name }
}
