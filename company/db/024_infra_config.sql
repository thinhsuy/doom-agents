-- 024_infra_config.sql — per-component tunable config for the infra drawer. The config
-- keys deliberately match the Terraform variable names (infra/variables.tf) so the
-- "Deploy" action can emit a directly-runnable `terraform apply` with matching -var flags.
ALTER TABLE company.infra_pricing ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE company.infra_pricing ADD COLUMN IF NOT EXISTS last_deploy_at timestamptz;

UPDATE company.infra_pricing
   SET config = '{"task_cpu":256,"task_memory":512,"desired_count":1}'::jsonb
 WHERE key = 'ecs_fargate' AND config = '{}'::jsonb;

UPDATE company.infra_pricing
   SET config = '{"db_instance_class":"db.t4g.micro","db_allocated_storage":20,"postgres_version":"17.9"}'::jsonb
 WHERE key = 'rds' AND config = '{}'::jsonb;
