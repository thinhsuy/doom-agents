#!/usr/bin/env bash
#
# deploy.sh — one-command deploy of Agency OS to AWS (ECR + ECS Fargate + RDS).
#
# Pipeline:  build (amd64) → push → DB migrate (one-off ECS task) → roll service → health-check.
# A failed migration ABORTS before the service is rolled, so a bad migration never goes live.
#
# Usage:
#   ./deploy.sh                 # full deploy
#   ./deploy.sh --skip-build    # image already pushed — just migrate + roll
#   ./deploy.sh --skip-migrate  # code-only change, no new migrations
#   ./deploy.sh --build-only    # build + push, then stop
#   ./deploy.sh -h              # help
#
# Override via env:  PROJECT, ENV, REGION  (defaults match infra/terraform.tfvars).
#
set -euo pipefail

# ---- config (override via env) ---------------------------------------------
PROJECT="${PROJECT:-agency-agents}"
ENV="${ENV:-prod}"
REGION="${REGION:-ap-southeast-1}"

# ---- flags -----------------------------------------------------------------
SKIP_BUILD=0; SKIP_MIGRATE=0; BUILD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --build-only)   BUILD_ONLY=1 ;;
    -h|--help)
      awk 'NR>=3{if($0!~/^#/)exit; sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try -h)"; exit 2 ;;
  esac
done

# ---- pretty logging --------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else B=""; G=""; Y=""; R=""; D=""; N=""; fi
section() { echo; echo "${B}▶ $*${N}"; }
ok()      { echo "${G}✓${N} $*"; }
info()    { echo "${D}  $*${N}"; }
die()     { echo "${R}✗ $*${N}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$REPO_ROOT/Dockerfile" ] || die "Dockerfile không thấy ở $REPO_ROOT"

# ---- derive names ----------------------------------------------------------
section "Chuẩn bị"
command -v aws    >/dev/null || die "cần AWS CLI"
command -v docker >/dev/null || die "cần Docker"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "AWS creds không dùng được (aws sts get-caller-identity fail)"

CLUSTER="$PROJECT-$ENV"
SERVICE="$PROJECT-$ENV"
TASK_DEF="$PROJECT-$ENV"
CONTAINER="$PROJECT"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
ECR="$REGISTRY/$PROJECT"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)"
ALB="$(aws elbv2 describe-load-balancers --names "$PROJECT-$ENV-alb" --region "$REGION" \
        --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || echo '')"

ok "account $ACCOUNT · region $REGION · cluster $CLUSTER"
info "image  $ECR:latest (+ :$GIT_SHA)"
[ -n "$ALB" ] && info "alb    http://$ALB" || info "alb    (chưa tìm thấy — bỏ qua health-check)"

# ---- 1. build + push -------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  section "1/4 · Build (linux/amd64) + push ECR"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  ok "đăng nhập ECR"
  # --platform linux/amd64: Fargate là amd64 (Mac Apple Silicon build ra arm64 sẽ không pull được).
  # --provenance=false: xuất 1 image đơn thay vì manifest list + attestation (khiến ECR/Fargate lỗi descriptor).
  docker build --platform linux/amd64 --provenance=false \
    -t "$ECR:latest" -t "$ECR:$GIT_SHA" "$REPO_ROOT"
  docker push "$ECR:latest"
  docker push "$ECR:$GIT_SHA"
  ok "đã push $ECR:latest và :$GIT_SHA"
else
  section "1/4 · Build — BỎ QUA (--skip-build)"
fi

[ "$BUILD_ONLY" = 1 ] && { section "Xong (--build-only)"; exit 0; }

# ---- 2. DB migrate (one-off ECS task, chạy trong VPC → RDS) -----------------
if [ "$SKIP_MIGRATE" = 0 ]; then
  section "2/4 · Migrate DB (one-off ECS task)"
  NETCFG="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
            --query 'services[0].networkConfiguration' --output json)"
  [ "$NETCFG" != "null" ] || die "không lấy được networkConfiguration của service $SERVICE"
  TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_DEF" \
    --launch-type FARGATE --region "$REGION" --network-configuration "$NETCFG" \
    --overrides '{"containerOverrides":[{"name":"'"$CONTAINER"'","command":["python","/app/company/db/migrate.py"]}]}' \
    --query 'tasks[0].taskArn' --output text)"
  [ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || die "run-task không trả về taskArn"
  TASK_ID="${TASK_ARN##*/}"
  info "task $TASK_ID — chờ chạy xong…"
  for _ in $(seq 1 90); do
    st="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
          --query 'tasks[0].lastStatus' --output text 2>/dev/null || echo '?')"
    [ "$st" = "STOPPED" ] && break
    sleep 5
  done
  EXIT="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
          --query 'tasks[0].containers[0].exitCode' --output text 2>/dev/null || echo '?')"
  if [ "$EXIT" != "0" ]; then
    echo "${R}migrate exit=$EXIT — log 40 dòng cuối:${N}" >&2
    LG="$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --region "$REGION" \
          --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text 2>/dev/null)"
    PFX="$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --region "$REGION" \
          --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-stream-prefix"' --output text 2>/dev/null)"
    aws logs get-log-events --log-group-name "$LG" --log-stream-name "$PFX/$CONTAINER/$TASK_ID" \
      --region "$REGION" --limit 60 --no-start-from-head --query 'events[].message' --output text 2>/dev/null | tail -40 >&2 || true
    die "migration THẤT BẠI — service KHÔNG được roll (dữ liệu cũ vẫn nguyên)."
  fi
  ok "migrate exit 0 — schema + roster + seeds đã cập nhật"
else
  section "2/4 · Migrate — BỎ QUA (--skip-migrate)"
fi

# ---- 3. roll service -------------------------------------------------------
section "3/4 · Roll service lên image mới"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment --region "$REGION" --query 'service.status' --output text >/dev/null
info "chờ rollout COMPLETED…"
ROLLED=0
for _ in $(seq 1 75); do
  RS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
        --query 'services[0].deployments[?status==`PRIMARY`].rolloutState | [0]' --output text 2>/dev/null || echo '?')"
  ND="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
        --query 'length(services[0].deployments)' --output text 2>/dev/null || echo '?')"
  if [ "$RS" = "COMPLETED" ] && [ "$ND" = "1" ]; then ROLLED=1; break; fi
  if [ "$RS" = "FAILED" ]; then die "rollout FAILED — kiểm tra ECS console / CloudWatch logs."; fi
  sleep 8
done
[ "$ROLLED" = 1 ] && ok "service ổn định, 1 deployment (PRIMARY)" || echo "${Y}⚠ rollout chưa COMPLETED sau ~10 phút — kiểm tra thủ công.${N}"

# ---- 4. health-check -------------------------------------------------------
if [ -n "$ALB" ]; then
  section "4/4 · Health-check"
  HC=000
  for _ in $(seq 1 12); do
    HC="$(curl -s -o /dev/null -w '%{http_code}' "http://$ALB/api/health" --max-time 15 2>/dev/null || echo 000)"
    [ "$HC" = "200" ] && break
    sleep 5
  done
  FE="$(curl -s -o /dev/null -w '%{http_code}' "http://$ALB/" --max-time 15 2>/dev/null || echo 000)"
  [ "$HC" = "200" ] && ok "/api/health → 200" || echo "${Y}⚠ /api/health → $HC${N}"
  [ "$FE" = "200" ] && ok "/ (FE) → 200"       || echo "${Y}⚠ / → $FE${N}"
fi

section "${G}Deploy xong${N}"
[ -n "$ALB" ] && echo "🔗 http://$ALB   (đăng nhập: ceo/cto/coo/cio)"
echo "${D}rollback: sửa image_tag của task def về :<git-sha-cũ> rồi ./deploy.sh --skip-build --skip-migrate${N}"
