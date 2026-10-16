# Internal Application Load Balancer across AZs. Reachable only from CloudFront
# through a VPC origin (no public listener). Exists only while enabled (demo_mode / prod).
variable "name" { type = string }
variable "enabled" { type = bool }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  count       = var.enabled ? 1 : 0
  name        = "${var.name}-alb"
  description = "ALB: HTTP only from CloudFront origin-facing range"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    from_port   = 8000
    to_port     = 8000
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
  tags = { component = "load_balancer" }
}

resource "aws_lb" "this" {
  count                      = var.enabled ? 1 : 0
  name                       = "${var.name}-alb"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = var.subnet_ids
  security_groups            = [aws_security_group.alb[0].id]
  idle_timeout               = 300 # long SSE streams
  drop_invalid_header_fields = true
  tags                       = { component = "load_balancer" }
}

resource "aws_lb_target_group" "app" {
  count                = var.enabled ? 1 : 0
  name                 = "${var.name}-app"
  port                 = 8000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { component = "load_balancer" }
}

resource "aws_lb_listener" "http" {
  count             = var.enabled ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
  tags = { component = "load_balancer" }
}

output "enabled" { value = var.enabled }
output "alb_arn" { value = var.enabled ? aws_lb.this[0].arn : null }
output "alb_dns" { value = var.enabled ? aws_lb.this[0].dns_name : null }
output "alb_security_group_id" { value = var.enabled ? aws_security_group.alb[0].id : null }
output "target_group_arn" { value = var.enabled ? aws_lb_target_group.app[0].arn : null }
