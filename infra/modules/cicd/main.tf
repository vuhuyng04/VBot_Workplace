# CI/CD identity: GitHub Actions assumes an AWS role through OIDC (no long-lived keys).
# Only workflow jobs bound to the GitHub environment "production" of this one repository
# can assume the deploy role, and that environment requires a manual approval in GitHub.
variable "name" { type = string }
variable "github_repo" {
  description = "owner/name"
  type        = string
}
variable "environment" {
  type    = string
  default = "production"
}
variable "state_bucket" { type = string }

data "aws_caller_identity" "me" {}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = { component = "cicd" }
}

data "aws_iam_policy_document" "trust_deploy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust_deploy.json
  max_session_duration = 3600
  tags                 = { component = "cicd" }
}

# Terraform manages IAM, KMS, VPC, data stores... so the deploy role needs broad rights;
# the guard is the trust policy above (one repo, one approved environment).
resource "aws_iam_role_policy_attachment" "deploy_admin" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# Plan role: pull requests from this repo (no environment) can run a read-only terraform plan.
data "aws_iam_policy_document" "trust_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:pull_request", "repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "${var.name}-github-plan"
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = 3600
  tags                 = { component = "cicd" }
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Refreshing state needs a few reads ReadOnlyAccess leaves out, plus the state lock file.
resource "aws_iam_role_policy" "plan_extra" {
  role = aws_iam_role.plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "kms:Decrypt"], Resource = "*",
      Condition = { StringEquals = { "aws:ResourceAccount" = data.aws_caller_identity.me.account_id } } },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject"],
      Resource = "arn:aws:s3:::${var.state_bucket}/envs/*.tflock" }
    ]
  })
}

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "plan_role_arn" { value = aws_iam_role.plan.arn }
