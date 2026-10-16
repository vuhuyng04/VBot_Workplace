# Data plane: KMS keys, per-user workspace bucket, audit bucket, DynamoDB tables,
# Aurora PostgreSQL Serverless v2 (pgvector) that auto-pauses to 0 ACU when idle.
variable "name" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "isolated_subnet_ids" { type = list(string) }
variable "db_instances" {
  description = "1 = MVP, 2 = prod (writer + reader in another AZ)"
  type        = number
}
variable "db_min_acu" { type = number }
variable "db_max_acu" { type = number }
variable "db_engine_version" { type = string }
variable "audit_retention_days" {
  description = "Object Lock GOVERNANCE retention (prod 365; MVP short so the stack can be destroyed)"
  type        = number
}
variable "force_destroy" { type = bool }

data "aws_caller_identity" "me" {}

# ---------- KMS: one key per data class ----------
locals {
  keys = ["workspace", "oauth", "audit", "db"]
}

resource "aws_kms_key" "k" {
  for_each                = toset(local.keys)
  description             = "${var.name} ${each.key} data key"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  tags                    = { component = "secrets_kms", data_class = each.key }
}

resource "aws_kms_alias" "k" {
  for_each      = toset(local.keys)
  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.k[each.key].key_id
}

# ---------- S3: workspace (one prefix per user: users/<sub>/...) ----------
resource "aws_s3_bucket" "workspace" {
  bucket        = "${var.name}-workspace-${data.aws_caller_identity.me.account_id}"
  force_destroy = var.force_destroy
  tags          = { component = "object_storage" }
}

resource "aws_s3_bucket_versioning" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.k["workspace"].arn
    }
    bucket_key_enabled = true # cuts KMS request cost
  }
}

resource "aws_s3_bucket_public_access_block" "workspace" {
  bucket                  = aws_s3_bucket.workspace.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  rule {
    id     = "intelligent-tiering"
    status = "Enabled"
    filter { prefix = "users/" }
    transition {
      days          = 0
      storage_class = "INTELLIGENT_TIERING"
    }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
  rule {
    id     = "sandbox-scratch"
    status = "Enabled"
    filter { prefix = "scratch/" }
    expiration { days = 1 }
  }
}

resource "aws_s3_bucket_cors_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["*"] # presigned URLs are per-object and short-lived
    allowed_headers = ["*"]
    max_age_seconds = 600
  }
}

resource "aws_s3_bucket_policy" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.workspace.arn, "${aws_s3_bucket.workspace.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------- S3: audit log, write-once ----------
resource "aws_s3_bucket" "audit" {
  bucket              = "${var.name}-audit-${data.aws_caller_identity.me.account_id}"
  object_lock_enabled = true
  force_destroy       = var.force_destroy
  tags                = { component = "governance" }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.audit_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.k["audit"].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    id     = "glacier-ir"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    expiration { days = 400 }
  }
}

# ---------- DynamoDB (on-demand, PITR) ----------
locals {
  tables = {
    sessions = { ttl = true, key = "db" }     # chat sessions, result cache
    quota    = { ttl = true, key = "db" }     # usage counters per user / unit / day
    oauth    = { ttl = false, key = "oauth" } # KMS-encrypted OAuth tokens per user + connector
    usage    = { ttl = true, key = "db" }     # per-request token + USD ledger
  }
}

resource "aws_dynamodb_table" "t" {
  for_each     = local.tables
  name         = "${var.name}-${each.key}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  dynamic "ttl" {
    for_each = each.value.ttl ? [1] : []
    content {
      attribute_name = "expires_at"
      enabled        = true
    }
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.k[each.value.key].arn
  }
  deletion_protection_enabled = !var.force_destroy
  tags                        = { component = "cache_queue", table = each.key }
}

# ---------- Aurora PostgreSQL Serverless v2 + pgvector ----------
resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = var.isolated_subnet_ids
  tags       = { component = "database" }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres from inside the VPC only"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = { component = "database" }
}

resource "aws_rds_cluster" "db" {
  cluster_identifier                  = "${var.name}-db"
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  engine_version                      = var.db_engine_version
  database_name                       = "vbot"
  master_username                     = "vbot_admin"
  manage_master_user_password         = true
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.k["db"].arn
  db_subnet_group_name                = aws_db_subnet_group.db.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  backup_retention_period             = 7 # PITR: RPO in minutes
  preferred_backup_window             = "18:00-19:00"
  copy_tags_to_snapshot               = true
  deletion_protection                 = !var.force_destroy
  skip_final_snapshot                 = var.force_destroy
  final_snapshot_identifier           = var.force_destroy ? null : "${var.name}-db-final"
  enable_http_endpoint                = true # RDS Data API: migrations without a bastion
  iam_database_authentication_enabled = true

  serverlessv2_scaling_configuration {
    min_capacity             = var.db_min_acu
    max_capacity             = var.db_max_acu
    seconds_until_auto_pause = var.db_min_acu == 0 ? 600 : null
  }
  tags = { component = "database" }
}

resource "aws_rds_cluster_instance" "db" {
  count                = var.db_instances
  identifier           = "${var.name}-db-${count.index}"
  cluster_identifier   = aws_rds_cluster.db.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.db.engine
  engine_version       = aws_rds_cluster.db.engine_version
  db_subnet_group_name = aws_db_subnet_group.db.name
  promotion_tier       = count.index
  tags                 = { component = "database" }
}

output "kms_key_arns" { value = { for k, v in aws_kms_key.k : k => v.arn } }
output "workspace_bucket" { value = aws_s3_bucket.workspace.id }
output "workspace_bucket_arn" { value = aws_s3_bucket.workspace.arn }
output "audit_bucket" { value = aws_s3_bucket.audit.id }
output "audit_bucket_arn" { value = aws_s3_bucket.audit.arn }
output "table_names" { value = { for k, v in aws_dynamodb_table.t : k => v.name } }
output "table_arns" { value = { for k, v in aws_dynamodb_table.t : k => v.arn } }
output "db_cluster_arn" { value = aws_rds_cluster.db.arn }
output "db_cluster_id" { value = aws_rds_cluster.db.id }
output "db_endpoint" { value = aws_rds_cluster.db.endpoint }
output "db_secret_arn" { value = aws_rds_cluster.db.master_user_secret[0].secret_arn }
