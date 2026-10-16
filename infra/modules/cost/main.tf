# Cost guardrails: account budget with staged alerts, anomaly detection, cost allocation tags.
# Root cannot be restricted by IAM budget actions, so enforcement = alerts + scripts/down.ps1.
variable "monthly_limit_usd" { type = number }
variable "alert_email" { type = string }
variable "thresholds_pct" {
  type    = list(number)
  default = [20, 50, 80, 100]
}

resource "aws_budgets_budget" "vbot" {
  name         = "vbot-mvp-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false # track gross spend, so credit burn is visible
    include_refund = false
  }

  dynamic "notification" {
    for_each = var.thresholds_pct
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# The account already has its one DIMENSIONAL/SERVICE monitor; a CUSTOM monitor scoped to project=vbot is allowed.
resource "aws_ce_anomaly_monitor" "services" {
  name         = "vbot-project-anomalies"
  monitor_type = "CUSTOM"
  monitor_specification = jsonencode({
    Tags = { Key = "user:project", Values = ["vbot"], MatchOptions = ["EQUALS"] }
  })
  lifecycle { ignore_changes = [monitor_specification] } # API returns a normalised document
}

resource "aws_ce_anomaly_subscription" "daily" {
  name             = "vbot-anomaly-daily"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]
  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["3"]
    }
  }
}

# Tags become cost dimensions in Cost Explorer (component = quote row code).
variable "activate_cost_tags" {
  description = "Tags must appear in billing data (~24h after first tagged usage) before activation"
  type        = bool
  default     = false
}

resource "aws_ce_cost_allocation_tag" "tags" {
  for_each = var.activate_cost_tags ? toset(["project", "component", "env"]) : toset([])
  tag_key  = each.value
  status   = "Active"
}
