# AWS Backup: daily backups of Aurora + DynamoDB (tag backup=daily) with a copy to the DR
# region (us-west-2). PITR on Aurora/DynamoDB covers RPO in minutes inside the region.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", configuration_aliases = [aws.dr] }
  }
}

variable "name" { type = string }
variable "resource_arns" { type = list(string) }
variable "retention_days" { type = number }

resource "aws_backup_vault" "primary" {
  name          = "${var.name}-primary"
  force_destroy = true
  tags          = { component = "backup_dr" }
}

resource "aws_backup_vault" "dr" {
  provider      = aws.dr
  name          = "${var.name}-dr"
  force_destroy = true
  tags          = { component = "backup_dr" }
}

resource "aws_backup_plan" "daily" {
  name = "${var.name}-daily"
  rule {
    rule_name         = "daily-with-dr-copy"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 18 * * ? *)" # 01:00 GMT+7
    start_window      = 60
    completion_window = 240
    lifecycle { delete_after = var.retention_days }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = var.retention_days }
    }
  }
  tags = { component = "backup_dr" }
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = { component = "backup_dr" }
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each   = toset(["AWSBackupServiceRolePolicyForBackup", "AWSBackupServiceRolePolicyForRestores"])
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/${each.value}"
}

resource "aws_backup_selection" "data" {
  name         = "${var.name}-data"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = var.resource_arns
}
