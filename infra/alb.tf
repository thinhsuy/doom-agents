# Public entry point. The ALB terminates HTTP(S) and forwards to the ECS task; it handles
# WebSocket upgrades (the office /ws/office stream) natively. It is the main fixed cost of
# this stack (~$16-20/mo) — the price of a stable URL + health-based restarts + TLS.

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  tags               = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # Fargate awsvpc = IP targets

  health_check {
    path                = "/api/health" # open endpoint (not behind the auth gate)
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Sticky sessions help the in-memory WebSocket hub when desired_count > 1.
  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400
  }

  tags = { Name = "${local.name}-tg" }
}

# HTTP listener. With a cert (acm_certificate_arn) it redirects to HTTPS; without, it serves
# the app directly on port 80.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = local.enable_https ? "redirect" : "forward"

    target_group_arn = local.enable_https ? null : aws_lb_target_group.app.arn

    dynamic "redirect" {
      for_each = local.enable_https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
