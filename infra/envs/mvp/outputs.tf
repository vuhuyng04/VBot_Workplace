output "url" { value = try(module.edge[0].url, module.app.url) }
output "app" {
  value = {
    url              = module.app.url
    api_function     = module.app.api_function
    sandbox_function = module.app.sandbox_function
    state_machine    = module.app.state_machine_arn
    db_app_secret    = module.app.db_app_secret_arn
    config_param     = module.app.config_param
  }
}
output "demo_mode" { value = var.demo_mode }
output "cognito" {
  value = {
    user_pool_id = module.identity.user_pool_id
    client_id    = module.identity.client_id
    domain       = module.identity.domain
    issuer       = module.identity.issuer
  }
}
output "data" {
  value = {
    workspace_bucket = module.data.workspace_bucket
    audit_bucket     = module.data.audit_bucket
    tables           = module.data.table_names
    db_cluster_arn   = module.data.db_cluster_arn
    db_secret_arn    = module.data.db_secret_arn
    db_endpoint      = module.data.db_endpoint
    kms              = module.data.kms_key_arns
  }
}
output "guardrail" {
  value = { id = module.llm.guardrail_id, version = module.llm.guardrail_version }
}
output "web_bucket" { value = try(module.edge[0].web_bucket, null) }
output "distribution_id" { value = try(module.edge[0].distribution_id, null) }
output "cicd" {
  value = { deploy_role_arn = module.cicd.deploy_role_arn, plan_role_arn = module.cicd.plan_role_arn }
}
