variable "env" {
  type    = string
  default = "mvp"
}
variable "name" {
  type    = string
  default = "vbot"
}
variable "demo_mode" {
  description = "true = bring up the paid always-on parts (ALB, Fargate, NAT, Bedrock endpoint, WAF) for a demo window"
  type        = bool
  default     = false
}
variable "alert_email" { type = string }
variable "budget_usd" {
  type    = number
  default = 50
}
variable "activate_cost_tags" {
  type    = bool
  default = false
}
variable "guardrail_enabled" {
  type    = bool
  default = true
}
variable "google_client_id" {
  type    = string
  default = ""
}
variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}
variable "edge_enabled" {
  description = "CloudFront needs the AWS account to be verified by AWS Support"
  type        = bool
  default     = false
}
variable "llm_provider" {
  description = "auto (Bedrock first, Claude API fallback when a key is set) | bedrock | anthropic"
  type        = string
  default     = "auto"
}
variable "anthropic_workspace_id" {
  description = "Claude Console workspace ID (wrkspc_...) used with a user-level API key"
  type        = string
  default     = ""
}
variable "anthropic_api_key" {
  type      = string
  default   = ""
  sensitive = true
}
variable "aws_profile" {
  description = "Local CLI profile (\"root\"); empty in CI where OIDC credentials come from the environment"
  type        = string
  default     = ""
}
variable "github_repo" {
  type    = string
  default = "vuhuyng04/VBot_Workplace"
}
