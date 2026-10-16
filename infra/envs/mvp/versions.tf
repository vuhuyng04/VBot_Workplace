terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "vbot-tfstate-231143200719"
    key          = "envs/mvp/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = var.aws_profile != "" ? var.aws_profile : null
  default_tags {
    tags = { project = "vbot", env = var.env, managed_by = "terraform", owner = "G03" }
  }
}

provider "aws" {
  alias   = "dr"
  region  = "us-west-2"
  profile = var.aws_profile != "" ? var.aws_profile : null
  default_tags {
    tags = { project = "vbot", env = var.env, managed_by = "terraform", owner = "G03", component = "backup_dr" }
  }
}
