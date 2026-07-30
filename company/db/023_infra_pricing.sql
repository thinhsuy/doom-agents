-- 023_infra_pricing.sql — estimated MONTHLY cost of the AWS infrastructure that runs this
-- app (the minimal Terraform stack in infra/). Shown in the Monitor tab in place of the LLM
-- model-price grid, so the COO can manage infra spend. Figures are estimates for the
-- ap-southeast-1 minimal stack — edit a row (UPDATE) + `npm run data` to re-price.
CREATE TABLE IF NOT EXISTS company.infra_pricing (
  key             text PRIMARY KEY,
  service         text NOT NULL,
  spec            text,
  est_monthly_usd numeric(10,2) NOT NULL DEFAULT 0,
  note            text,
  sort            int NOT NULL DEFAULT 100
);

INSERT INTO company.infra_pricing (key, service, spec, est_monthly_usd, note, sort) VALUES
  ('ecs_fargate',   'ECS Fargate',                 '1 task · 0.25 vCPU / 0.5 GB · 730h', 10.40, 'Container ứng dụng (FastAPI + FE + WebSocket)', 10),
  ('alb',           'Application Load Balancer',   'HTTP/WS · 2 AZ',                     18.00, 'URL ổn định + health check + sẵn TLS',        20),
  ('rds',           'RDS PostgreSQL',              'db.t4g.micro · 20GB gp3 · single-AZ',15.80, 'DB doom_agents (compute + storage + backup)',  30),
  ('data_transfer', 'Data transfer + IPv4',        'Fargate public IP · egress',          4.00, 'Không dùng NAT gateway (tiết kiệm ~$32/mo)',   40),
  ('s3',            'S3',                          'bucket riêng · ít dữ liệu',           1.00, 'Tài liệu / artifact / backup',                50),
  ('cloudwatch',    'CloudWatch Logs',             'retention 14 ngày',                   0.50, 'Log container',                               60),
  ('ecr',           'ECR',                         'giữ ≤10 image',                       0.50, 'Registry image agency-agents',                70)
ON CONFLICT (key) DO NOTHING;
