# Bedrock guardrail (H4/H5): prompt-attack filter for untrusted connector content,
# PII masking on outputs, invocation logging off by default (prompts stay out of logs).
variable "name" { type = string }
variable "enabled" { type = bool }

resource "aws_bedrock_guardrail" "this" {
  count                     = var.enabled ? 1 : 0
  name                      = "${var.name}-guard"
  description               = "VBot: prompt injection + PII"
  blocked_input_messaging   = "Nội dung này bị chặn vì có dấu hiệu chèn lệnh hoặc vi phạm chính sách."
  blocked_outputs_messaging = "Câu trả lời bị chặn theo chính sách dữ liệu."

  content_policy_config {
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
  }

  sensitive_information_policy_config {
    dynamic "pii_entities_config" {
      for_each = ["EMAIL", "PHONE", "CREDIT_DEBIT_CARD_NUMBER", "PASSWORD", "AWS_ACCESS_KEY", "AWS_SECRET_KEY", "US_BANK_ACCOUNT_NUMBER"]
      content {
        type   = pii_entities_config.value
        action = "ANONYMIZE"
      }
    }
    regexes_config {
      name        = "vn-citizen-id"
      description = "CCCD 12 chữ số"
      pattern     = "\\b0\\d{11}\\b"
      action      = "ANONYMIZE"
    }
  }
  tags = { component = "governance" }
}

resource "aws_bedrock_guardrail_version" "v" {
  count         = var.enabled ? 1 : 0
  guardrail_arn = aws_bedrock_guardrail.this[0].guardrail_arn
  description   = "pinned for prod; eval gate promotes new versions"
}

output "guardrail_id" { value = var.enabled ? aws_bedrock_guardrail.this[0].guardrail_id : "" }
output "guardrail_version" { value = var.enabled ? aws_bedrock_guardrail_version.v[0].version : "" }
