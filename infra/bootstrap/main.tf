# Foundation: the remote-state bucket, the model registry and the worker's ECR
# repository. These must exist before the app stack can init its backend or
# reference an image.
#
# First run (chicken and egg): comment out the backend block, apply with local
# state, then restore it and move the state into the bucket it just created:
#   scripts/tf.sh -chdir=infra/bootstrap init -migrate-state -backend-config=bucket=holopaint-tfstate-<account-id>

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    key          = "bootstrap/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "holopaint-cloud"
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

module "state_bucket" {
  source    = "../modules/private_bucket"
  name      = "holopaint-tfstate-${local.account_id}"
  versioned = true # recover from a bad apply by restoring an older state
}

module "model_registry" {
  source    = "../modules/private_bucket"
  name      = "holopaint-models-${local.account_id}"
  versioned = true
}

resource "aws_ecr_repository" "worker" {
  name                 = "holopaint-worker"
  image_tag_mutability = "IMMUTABLE" # a tag (git SHA) always means the same image

  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images (enough to roll back)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "lambda_pull" {
  statement {
    sid     = "LambdaPull"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "aws:sourceArn"
      values   = ["arn:aws:lambda:${var.region}:${local.account_id}:function:*"]
    }
  }
}

resource "aws_ecr_repository_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy     = data.aws_iam_policy_document.lambda_pull.json
}
