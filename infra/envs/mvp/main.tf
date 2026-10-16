# VBot MVP: same architecture as the 2.000 DAU quote, smaller sizes.
# Always-on parts are pay-per-use (near 0 when idle); demo_mode adds the hourly-billed parts.
locals {
  az_count = 2
  app_urls = concat([for e in module.edge : "${e.url}/"], [module.app.url], ["http://localhost:8080/"])
}

module "cost" {
  source             = "../../modules/cost"
  monthly_limit_usd  = var.budget_usd
  alert_email        = var.alert_email
  activate_cost_tags = var.activate_cost_tags
}

module "network" {
  source           = "../../modules/network"
  name             = "${var.name}-${var.env}"
  cidr             = "10.40.0.0/16"
  az_count         = local.az_count
  nat_count        = var.demo_mode ? 1 : 0 # prod: 1 per AZ
  bedrock_endpoint = var.demo_mode
}

module "data" {
  source               = "../../modules/data"
  name                 = "${var.name}-${var.env}"
  vpc_id               = module.network.vpc_id
  vpc_cidr             = module.network.cidr
  isolated_subnet_ids  = module.network.isolated_subnet_ids
  db_instances         = 1 # prod: 2 (writer + reader in another AZ)
  db_min_acu           = 0 # auto-pause when idle
  db_max_acu           = 4
  db_engine_version    = "17.7"
  audit_retention_days = 1 # prod: 365
  force_destroy        = true
}

module "lb" {
  source     = "../../modules/lb"
  name       = "${var.name}-${var.env}"
  enabled    = var.demo_mode
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.app_subnet_ids
}

module "edge" {
  count         = var.edge_enabled ? 1 : 0
  source        = "../../modules/edge"
  name          = "${var.name}-${var.env}"
  alb_arn       = module.lb.alb_arn
  alb_dns       = module.lb.alb_dns
  waf_enabled   = var.demo_mode
  force_destroy = true
}

module "identity" {
  source               = "../../modules/identity"
  name                 = "${var.name}-${var.env}"
  callback_urls        = local.app_urls
  logout_urls          = local.app_urls
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

module "llm" {
  source  = "../../modules/llm"
  name    = "${var.name}-${var.env}"
  enabled = var.guardrail_enabled
}

module "app" {
  source              = "../../modules/app"
  name                = var.name
  env                 = var.env
  app_zip             = "${path.root}/../../../dist/app.zip"
  sandbox_zip         = "${path.root}/../../../dist/sandbox.zip"
  vpc_id              = module.network.vpc_id
  isolated_subnet_ids = module.network.isolated_subnet_ids
  s3_prefix_list_id   = module.network.s3_prefix_list_id
  cognito = {
    user_pool_id  = module.identity.user_pool_id
    user_pool_arn = module.identity.user_pool_arn
    client_id     = module.identity.client_id
    domain        = module.identity.domain
  }
  data = {
    workspace_bucket     = module.data.workspace_bucket
    workspace_bucket_arn = module.data.workspace_bucket_arn
    audit_bucket         = module.data.audit_bucket
    audit_bucket_arn     = module.data.audit_bucket_arn
    table_names          = module.data.table_names
    table_arns           = module.data.table_arns
    db_cluster_arn       = module.data.db_cluster_arn
    kms_key_arns         = module.data.kms_key_arns
  }
  guardrail              = { id = module.llm.guardrail_id, version = module.llm.guardrail_version }
  llm_provider           = var.llm_provider
  anthropic_api_key      = var.anthropic_api_key
  anthropic_workspace_id = var.anthropic_workspace_id
}

module "observability" {
  source            = "../../modules/observability"
  name              = "${var.name}-${var.env}"
  alert_email       = var.alert_email
  api_function      = module.app.api_function
  sandbox_function  = module.app.sandbox_function
  agent_function    = module.app.agent_function
  state_machine_arn = module.app.state_machine_arn
}

module "backup_dr" {
  source         = "../../modules/backup_dr"
  providers      = { aws = aws, aws.dr = aws.dr }
  name           = "${var.name}-${var.env}"
  resource_arns  = concat([module.data.db_cluster_arn], values(module.data.table_arns))
  retention_days = 7 # prod: 35
}

module "cicd" {
  source      = "../../modules/cicd"
  name        = var.name
  github_repo = var.github_repo
  # gh api repos/<repo>/actions/oidc/customization/sub -> sub_claim_prefix
  github_sub_prefix = "repo:vuhuyng04@191273751/VBot_Workplace@1421606247"
  state_bucket      = "vbot-tfstate-231143200719"
}
