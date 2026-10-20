# HoloPaint Cloud: browser -> HTTP API -> presigned POST -> S3 -> SQS (+DLQ)
# -> worker Lambda (ONNX INT8) -> S3 result + DynamoDB job status.
#
#   scripts/tf.sh -chdir=infra/app init -backend-config=bucket=holopaint-tfstate-<account-id>
#   scripts/tf.sh -chdir=infra/app apply -var worker_image_tag=<git-sha>

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # bucket is passed at init (-backend-config); it contains the account ID.
  backend "s3" {
    key          = "app/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true # S3-native state locking, no DynamoDB lock table
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "holopaint-cloud"
      ManagedBy = "terraform"
      Stack     = "app"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_ecr_repository" "worker" {
  name = "holopaint-worker"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  name       = "holopaint"
}

module "media" {
  source               = "../modules/private_bucket"
  name                 = "${local.name}-media-${local.account_id}"
  expire_after_days    = 1 # photos and results are deleted after a day
  cors_allowed_origins = var.allowed_origins
  cors_allowed_methods = ["GET", "POST"]
  force_destroy        = true # contents are disposable
}

module "jobs_table" {
  source = "../modules/jobs_table"
  name   = "${local.name}-jobs"
}

module "queue" {
  source                     = "../modules/queue"
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 6 * var.worker_timeout_seconds
  max_receive_count          = 3
  source_bucket_arn          = module.media.arn
  account_id                 = local.account_id
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = module.media.id

  queue {
    queue_arn     = module.queue.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "uploads/"
  }

  depends_on = [module.queue] # S3 validates it can send before saving this
}

module "worker" {
  source            = "../modules/worker"
  name              = "${local.name}-worker"
  image_uri         = "${data.aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"
  model_version     = var.model_version
  memory_mb         = var.worker_memory_mb
  ort_threads       = var.worker_ort_threads
  timeout_seconds   = var.worker_timeout_seconds
  max_concurrency   = var.worker_max_concurrency
  bucket_arn        = module.media.arn
  table_name        = module.jobs_table.name
  table_arn         = module.jobs_table.arn
  queue_arn         = module.queue.arn
  max_receive_count = module.queue.max_receive_count
}

module "api" {
  source          = "../modules/api"
  name            = "${local.name}-api"
  source_file     = "${path.module}/../../api/app.py"
  allowed_origins = var.allowed_origins
  rate_limit      = var.api_rate_limit
  burst_limit     = var.api_burst_limit
  bucket_name     = module.media.id
  bucket_arn      = module.media.arn
  table_name      = module.jobs_table.name
  table_arn       = module.jobs_table.arn
}
