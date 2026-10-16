# Application tier on Lambda (arm64):
#   api     FastAPI + SPA behind a Lambda Function URL (HTTPS, response streaming)
#   agent   Step Functions state machine whose tasks are Lambda handlers (plan -> confirm -> execute -> notify)
#   sandbox isolated Lambda (no Internet; HTTPS only to S3 via gateway endpoint) for user code
# Runtime settings are one JSON document in SSM; Lambdas only get the parameter name.
variable "name" { type = string }
variable "env" { type = string }
variable "app_zip" { type = string }
variable "sandbox_zip" { type = string }
variable "vpc_id" { type = string }
variable "isolated_subnet_ids" { type = list(string) }
variable "s3_prefix_list_id" { type = string }
variable "cognito" { type = object({ user_pool_id = string, user_pool_arn = string, client_id = string, domain = string }) }
variable "data" {
  type = object({
    workspace_bucket     = string
    workspace_bucket_arn = string
    audit_bucket         = string
    audit_bucket_arn     = string
    table_names          = map(string)
    table_arns           = map(string)
    db_cluster_arn       = string
    kms_key_arns         = map(string)
  })
}
variable "guardrail" { type = object({ id = string, version = string }) }
variable "llm_provider" {
  type    = string
  default = "bedrock"
}
variable "anthropic_api_key" {
  description = "Optional: first-party Claude API key, used only when llm_provider = anthropic"
  type        = string
  default     = ""
  sensitive   = true
}
variable "log_retention_days" {
  type    = number
  default = 14
}

data "aws_caller_identity" "me" {}
data "aws_region" "current" {}

locals {
  prefix   = "${var.name}-${var.env}"
  lwa      = "arn:aws:lambda:${data.aws_region.current.region}:753240598075:layer:LambdaAdapterLayerArm64:25"
  sm_arn   = "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.me.account_id}:stateMachine:${local.prefix}-agent"
  cfg_name = "/${var.name}/${var.env}/config"
}

# ---------------- artifacts ----------------
resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.prefix}-artifacts-${data.aws_caller_identity.me.account_id}"
  force_destroy = true
  tags          = { component = "cicd" }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "app" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "app-${filemd5(var.app_zip)}.zip"
  source      = var.app_zip
  source_hash = filemd5(var.app_zip)
  tags        = { component = "cicd" }
}

resource "aws_s3_object" "sandbox" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "sandbox-${filemd5(var.sandbox_zip)}.zip"
  source      = var.sandbox_zip
  source_hash = filemd5(var.sandbox_zip)
  tags        = { component = "cicd" }
}

# ---------------- secrets + config ----------------
resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_app" {
  name                    = "${local.prefix}/db/vbot_app"
  description             = "Aurora login for the RLS-restricted application role (RDS Data API)"
  kms_key_id              = var.data.kms_key_arns["db"]
  recovery_window_in_days = 0
  tags                    = { component = "secrets_kms" }
}

resource "aws_secretsmanager_secret_version" "db_app" {
  secret_id     = aws_secretsmanager_secret.db_app.id
  secret_string = jsonencode({ username = "vbot_app", password = random_password.db_app.result })
}

resource "aws_secretsmanager_secret" "anthropic" {
  count                   = var.anthropic_api_key != "" ? 1 : 0
  name                    = "${local.prefix}/llm/anthropic"
  kms_key_id              = var.data.kms_key_arns["oauth"]
  recovery_window_in_days = 0
  tags                    = { component = "secrets_kms" }
}

resource "aws_secretsmanager_secret_version" "anthropic" {
  count         = var.anthropic_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.anthropic[0].id
  secret_string = var.anthropic_api_key
}

resource "aws_ssm_parameter" "config" {
  name = local.cfg_name
  type = "String"
  tier = "Standard"
  value = jsonencode({
    region                = data.aws_region.current.region
    env                   = var.env
    user_pool_id          = var.cognito.user_pool_id
    client_id             = var.cognito.client_id
    cognito_domain        = var.cognito.domain
    db_cluster_arn        = var.data.db_cluster_arn
    db_app_secret_arn     = aws_secretsmanager_secret.db_app.arn
    workspace_bucket      = var.data.workspace_bucket
    audit_bucket          = var.data.audit_bucket
    tables                = var.data.table_names
    kms_oauth_key         = var.data.kms_key_arns["oauth"]
    guardrail_id          = var.guardrail.id
    guardrail_version     = var.guardrail.version
    sandbox_function      = "${local.prefix}-sandbox"
    agent_state_machine   = local.sm_arn
    llm_provider          = var.llm_provider
    anthropic_secret_arn  = var.anthropic_api_key != "" ? aws_secretsmanager_secret.anthropic[0].arn : ""
    daily_user_budget_usd = 2.0
  })
  tags = { component = "compute" }
}

# ---------------- IAM: API + agent tasks ----------------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = { component = "compute" }
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Config"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.me.account_id}:parameter${local.cfg_name}"]
  }
  statement {
    sid       = "Db"
    actions   = ["rds-data:ExecuteStatement", "rds-data:BatchExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"]
    resources = [var.data.db_cluster_arn]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([aws_secretsmanager_secret.db_app.arn], aws_secretsmanager_secret.anthropic[*].arn)
  }
  statement {
    sid       = "Tables"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:DeleteItem"]
    resources = values(var.data.table_arns)
  }
  statement {
    sid       = "Workspace"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.data.workspace_bucket_arn}/users/*"]
  }
  statement {
    sid       = "WorkspaceList"
    actions   = ["s3:ListBucket"]
    resources = [var.data.workspace_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["users/*"]
    }
  }
  statement {
    sid       = "Audit"
    actions   = ["s3:PutObject"]
    resources = ["${var.data.audit_bucket_arn}/audit/*"]
  }
  statement {
    sid       = "Keys"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"]
    resources = values(var.data.kms_key_arns)
  }
  statement {
    sid = "Models"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ApplyGuardrail",
    "bedrock:GetInferenceProfile", "bedrock-mantle:*"]
    resources = ["*"]
  }
  statement {
    sid       = "Sandbox"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.sandbox.arn]
  }
  statement {
    sid       = "Agent"
    actions   = ["states:StartExecution", "states:SendTaskSuccess", "states:SendTaskFailure"]
    resources = [local.sm_arn, "${replace(local.sm_arn, ":stateMachine:", ":execution:")}:*"]
  }
  statement {
    sid       = "CostTransparency"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ---------------- API Lambda + Function URL ----------------
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.prefix}-api"
  retention_in_days = var.log_retention_days
  tags              = { component = "monitoring" }
}

resource "aws_lambda_function" "api" {
  function_name = "${local.prefix}-api"
  role          = aws_iam_role.api.arn
  runtime       = "python3.12"
  architectures = ["arm64"]
  handler       = "run.sh"
  s3_bucket     = aws_s3_object.app.bucket
  s3_key        = aws_s3_object.app.key
  memory_size   = 1024
  timeout       = 300
  layers        = [local.lwa]
  environment {
    variables = {
      AWS_LAMBDA_EXEC_WRAPPER      = "/opt/bootstrap"
      AWS_LWA_INVOKE_MODE          = "response_stream"
      AWS_LWA_READINESS_CHECK_PATH = "/api/health"
      PORT                         = "8080"
      PYTHONUNBUFFERED             = "1"
      VBOT_CONFIG_PARAM            = local.cfg_name # literal: breaks the Cognito callback <-> config cycle
    }
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy_attachment.api_logs]
  tags       = { component = "compute" }
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE" # end-user auth = Cognito JWT checked by the app
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "public-function-url"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "public-function-url-invoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_iam_role_policy_attachment" "api_xray" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# ---------------- agent step Lambda ----------------
resource "aws_cloudwatch_log_group" "agent" {
  name              = "/aws/lambda/${local.prefix}-agent"
  retention_in_days = var.log_retention_days
  tags              = { component = "monitoring" }
}

resource "aws_lambda_function" "agent" {
  function_name = "${local.prefix}-agent"
  role          = aws_iam_role.api.arn
  runtime       = "python3.12"
  architectures = ["arm64"]
  handler       = "vbot.agent_steps.handler"
  s3_bucket     = aws_s3_object.app.bucket
  s3_key        = aws_s3_object.app.key
  memory_size   = 1024
  timeout       = 300
  environment {
    variables = { VBOT_CONFIG_PARAM = local.cfg_name, PYTHONUNBUFFERED = "1" }
  }
  depends_on = [aws_cloudwatch_log_group.agent, aws_iam_role_policy_attachment.api_logs]
  tags       = { component = "cache_queue" }
}

# ---------------- Step Functions ----------------
data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.prefix}-agent-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
  tags               = { component = "cache_queue" }
}

resource "aws_iam_role_policy" "sfn" {
  role = aws_iam_role.sfn.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [aws_lambda_function.agent.arn, "${aws_lambda_function.agent.arn}:*"] }]
  })
}

locals {
  step = { for s in ["plan", "execute", "notify", "on_reject", "on_error"] : s => {
    Type           = "Task"
    Resource       = "arn:aws:states:::lambda:invoke"
    Parameters     = { FunctionName = aws_lambda_function.agent.arn, Payload = { step = s, "payload.$" = "$" } }
    ResultSelector = { "result.$" = "$.Payload" }
    Retry = [{ ErrorEquals = ["Lambda.ServiceException", "Lambda.TooManyRequestsException", "Lambda.SdkClientException"],
    IntervalSeconds = 2, MaxAttempts = 3, BackoffRate = 2 }]
  } }
}

resource "aws_sfn_state_machine" "agent" {
  name     = "${local.prefix}-agent"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "VBot tier-4 agent: plan, wait for user confirmation, execute write actions, notify"
    StartAt = "Plan"
    States = {
      Plan = merge(local.step["plan"], {
        OutputPath = "$.result", TimeoutSeconds = 300, Next = "Confirm",
        Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "OnError" }]
      })
      Confirm = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        Parameters = { FunctionName = aws_lambda_function.agent.arn,
        Payload = { step = "request_confirmation", payload = { "input.$" = "$", "token.$" = "$$.Task.Token" } } }
        ResultPath     = "$.approval"
        TimeoutSeconds = 86400
        Next           = "Execute"
        Catch = [{ ErrorEquals = ["Rejected", "States.Timeout"], ResultPath = "$.error", Next = "OnReject" },
        { ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "OnError" }]
      }
      Execute = merge(local.step["execute"], {
        OutputPath = "$.result", TimeoutSeconds = 600, Next = "Notify",
        Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "OnError" }]
      })
      Notify   = merge(local.step["notify"], { End = true })
      OnReject = merge(local.step["on_reject"], { End = true })
      OnError  = merge(local.step["on_error"], { End = true })
    }
  })
  tags = { component = "cache_queue" }
}

# ---------------- sandbox ----------------
resource "aws_iam_role" "sandbox" {
  name               = "${local.prefix}-sandbox"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = { component = "sandbox" }
}

# ENI management + logs only: no data permissions at all.
resource "aws_iam_role_policy_attachment" "sandbox" {
  role       = aws_iam_role.sandbox.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_security_group" "sandbox" {
  name        = "${local.prefix}-sandbox"
  description = "Sandbox: no inbound; outbound HTTPS to S3 (presigned URLs) only"
  vpc_id      = var.vpc_id
  egress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [var.s3_prefix_list_id]
  }
  tags = { component = "sandbox" }
}

resource "aws_cloudwatch_log_group" "sandbox" {
  name              = "/aws/lambda/${local.prefix}-sandbox"
  retention_in_days = var.log_retention_days
  tags              = { component = "monitoring" }
}

resource "aws_lambda_function" "sandbox" {
  function_name = "${local.prefix}-sandbox"
  role          = aws_iam_role.sandbox.arn
  runtime       = "python3.12"
  architectures = ["arm64"]
  handler       = "handler.handler"
  s3_bucket     = aws_s3_object.sandbox.bucket
  s3_key        = aws_s3_object.sandbox.key
  memory_size   = 2048
  timeout       = 300
  ephemeral_storage { size = 1024 }
  vpc_config {
    subnet_ids         = var.isolated_subnet_ids
    security_group_ids = [aws_security_group.sandbox.id]
  }
  depends_on = [aws_cloudwatch_log_group.sandbox, aws_iam_role_policy_attachment.sandbox]
  tags       = { component = "sandbox" }
}

output "url" { value = aws_lambda_function_url.api.function_url }
output "api_function" { value = aws_lambda_function.api.function_name }
output "agent_function" { value = aws_lambda_function.agent.function_name }
output "sandbox_function" { value = aws_lambda_function.sandbox.function_name }
output "state_machine_arn" { value = aws_sfn_state_machine.agent.arn }
output "db_app_secret_arn" { value = aws_secretsmanager_secret.db_app.arn }
output "db_app_password" {
  value     = random_password.db_app.result
  sensitive = true
}
output "config_param" { value = aws_ssm_parameter.config.name }
