# Minimal single-AZ Postgres. Not publicly accessible; reachable only from the ECS SG.
resource "random_password" "db" {
  length  = 24
  special = false # keep it URL/psql-safe (no shell-quoting surprises)
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name}-db-subnets" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 2 # gp3 autoscaling headroom
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false # single-AZ = cheapest

  backup_retention_period    = var.db_backup_retention_days
  auto_minor_version_upgrade = true
  deletion_protection        = false # flip to true for real prod
  skip_final_snapshot        = true  # set false + final_snapshot_identifier for real prod
  apply_immediately          = true

  tags = { Name = "${local.name}-pg" }
}
