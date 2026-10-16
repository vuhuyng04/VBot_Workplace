# Alarms (email via SNS) + one CloudWatch dashboard for the platform.
variable "name" { type = string }
variable "alert_email" { type = string }
variable "api_function" { type = string }
variable "sandbox_function" { type = string }
variable "agent_function" { type = string }
variable "state_machine_arn" { type = string }

data "aws_region" "current" {}

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
  tags = { component = "monitoring" }
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  fn_alarms = {
    api_errors     = { fn = var.api_function, metric = "Errors", threshold = 5 }
    api_throttles  = { fn = var.api_function, metric = "Throttles", threshold = 1 }
    sandbox_errors = { fn = var.sandbox_function, metric = "Errors", threshold = 3 }
    agent_errors   = { fn = var.agent_function, metric = "Errors", threshold = 3 }
  }
}

resource "aws_cloudwatch_metric_alarm" "fn" {
  for_each            = local.fn_alarms
  alarm_name          = "${var.name}-${each.key}"
  namespace           = "AWS/Lambda"
  metric_name         = each.value.metric
  dimensions          = { FunctionName = each.value.fn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { component = "monitoring" }
}

resource "aws_cloudwatch_metric_alarm" "api_p95" {
  alarm_name          = "${var.name}-api-duration-p95"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = var.api_function }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 60000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { component = "monitoring" }
}

resource "aws_cloudwatch_metric_alarm" "agent_failed" {
  alarm_name          = "${var.name}-agent-failed"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = var.state_machine_arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { component = "monitoring" }
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = {
        title   = "API: requests, errors, throttles", region = data.aws_region.current.region, stat = "Sum", period = 300,
        metrics = [["AWS/Lambda", "Invocations", "FunctionName", var.api_function], [".", "Errors", ".", "."], [".", "Throttles", ".", "."]]
      } },
      { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = {
        title   = "API duration p50/p95 (ms)", region = data.aws_region.current.region, period = 300,
        metrics = [["AWS/Lambda", "Duration", "FunctionName", var.api_function, { stat = "p50" }], ["...", { stat = "p95" }]]
      } },
      { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = {
        title   = "Sandbox runs and errors", region = data.aws_region.current.region, stat = "Sum", period = 300,
        metrics = [["AWS/Lambda", "Invocations", "FunctionName", var.sandbox_function], [".", "Errors", ".", "."]]
      } },
      { type = "metric", x = 12, y = 6, width = 12, height = 6, properties = {
        title   = "Agent executions", region = data.aws_region.current.region, stat = "Sum", period = 300,
        metrics = [["AWS/States", "ExecutionsStarted", "StateMachineArn", var.state_machine_arn], [".", "ExecutionsSucceeded", ".", "."], [".", "ExecutionsFailed", ".", "."]]
      } },
      { type = "log", x = 0, y = 12, width = 24, height = 6, properties = {
        title = "Chat: cost and TTFT per request", region = data.aws_region.current.region,
        query = "SOURCE '/aws/lambda/${var.api_function}' | filter msg = 'chat' | stats count() as requests, sum(usd) as usd, avg(ttft_s) as ttft_avg, pct(ttft_s, 95) as ttft_p95 by bin(1h)"
      } }
    ]
  })
}

output "topic_arn" { value = aws_sns_topic.alerts.arn }
