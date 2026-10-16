# SSO: Cognito user pool federating the corporate IdP (SAML/OIDC). MFA enforced.
# MVP stand-in for the corporate IdP: Google (OIDC) when client credentials are given;
# otherwise native users with TOTP MFA.
variable "name" { type = string }
variable "callback_urls" { type = list(string) }
variable "logout_urls" { type = list(string) }
variable "google_client_id" {
  type    = string
  default = ""
}
variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

data "aws_caller_identity" "me" {}

locals {
  google = var.google_client_id != ""
}

resource "aws_cognito_user_pool" "this" {
  name                = var.name
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = "INACTIVE"
  mfa_configuration   = "ON"
  software_token_mfa_configuration { enabled = true }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config { allow_admin_create_user_only = true } # no self sign-up: provisioned users only

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 3
  }

  schema {
    name                     = "department"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 0
      max_length = 64
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  tags = { component = "authn" }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = "${var.name}-${data.aws_caller_identity.me.account_id}"
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 2 # managed login (brandable); 1 = classic hosted UI
}

# VBot look for the managed login pages (sign-in, MFA setup and code, password reset).
# branding/settings.json = Cognito defaults with the VBot palette; logo text is outlined so no web font is needed.
resource "aws_cognito_managed_login_branding" "web" {
  user_pool_id = aws_cognito_user_pool.this.id
  client_id    = aws_cognito_user_pool_client.web.id
  settings     = jsonencode(jsondecode(file("${path.module}/branding/settings.json")))

  dynamic "asset" {
    for_each = { FORM_LOGO = "logo.svg", PAGE_BACKGROUND = "background.svg", FAVICON_SVG = "favicon.svg" }
    content {
      category   = asset.key
      color_mode = "LIGHT"
      extension  = "SVG"
      bytes      = filebase64("${path.module}/branding/${asset.value}")
    }
  }
  depends_on = [aws_cognito_user_pool_domain.this]
}

resource "aws_cognito_identity_provider" "google" {
  count         = local.google ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "Google"
  provider_type = "Google"
  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }
  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

# Role groups for RBAC (claims: cognito:groups)
resource "aws_cognito_user_group" "g" {
  for_each     = { user = 10, unit_admin = 5, platform_admin = 1 }
  name         = each.key
  user_pool_id = aws_cognito_user_pool.this.id
  precedence   = each.value
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.name}-web"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false # public SPA client, PKCE
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  supported_identity_providers         = local.google ? ["COGNITO", "Google"] : ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  access_token_validity                = 60
  id_token_validity                    = 60
  refresh_token_validity               = 10
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
  depends_on = [aws_cognito_identity_provider.google]
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "client_id" { value = aws_cognito_user_pool_client.web.id }
output "domain" { value = "${aws_cognito_user_pool_domain.this.domain}.auth.us-east-1.amazoncognito.com" }
output "issuer" { value = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.this.id}" }
