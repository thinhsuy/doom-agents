variable "project" {
  description = "Name prefix + tag for every resource (containers/services are named after this)."
  type        = string
  default     = "agency-agents"
}

variable "env" {
  description = "Environment suffix (prod/staging/dev)."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region. Default matches the app's Bedrock region (ap-southeast-1)."
  type        = string
  default     = "ap-southeast-1"
}

# ---- Networking -------------------------------------------------------------
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

# ---- Container / app --------------------------------------------------------
variable "container_port" {
  description = "Port the FastAPI app listens on inside the container."
  type        = number
  default     = 8000
}

variable "image_tag" {
  description = "ECR image tag to deploy (build & push the app image first — see README)."
  type        = string
  default     = "latest"
}

# Smallest Fargate size (0.25 vCPU / 0.5 GB) — cost-minimal. Bump if the worker/LLM loops
# need more headroom.
variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  description = "Number of running tasks. 1 = cheapest, single instance (WS broadcast is in-memory, so keep at 1 unless you add Redis)."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  type    = number
  default = 14
}

# ---- RDS Postgres (minimal) -------------------------------------------------
variable "postgres_version" {
  description = "RDS Postgres engine version. Verify availability: aws rds describe-db-engine-versions --engine postgres --region <r>. ap-southeast-1 offers 17.5–17.10; 17.9 matches the local dev container."
  type        = string
  default     = "17.9"
}

variable "db_instance_class" {
  description = "Smallest sensible class. db.t4g.micro (Graviton) is the cheapest burstable."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "GB of gp3 storage (20 = RDS minimum)."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Database name. Keep 'doom_agents' to match the app's migrations/queries."
  type        = string
  default     = "doom_agents"
}

variable "db_username" {
  type    = string
  default = "doom_agents"
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

# ---- HTTPS (optional) -------------------------------------------------------
variable "acm_certificate_arn" {
  description = "Optional ACM cert ARN. If set, the ALB serves HTTPS on 443; otherwise HTTP-only on 80."
  type        = string
  default     = ""
}

# ---- CI/CD (GitHub Actions OIDC) --------------------------------------------
variable "github_repo" {
  description = "GitHub repo (owner/name) allowed to assume the deploy role via OIDC on the main branch."
  type        = string
  default     = "thinhsuy/doom-agents"
}

variable "create_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Set false if the account already has one (only one per URL is allowed)."
  type        = bool
  default     = true
}
