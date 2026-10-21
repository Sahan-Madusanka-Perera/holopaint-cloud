# CD inside AWS. The account's SCP blocks IAM OIDC providers, so GitHub Actions
# can't assume a role here; instead a CodeConnections link lets CodePipeline
# watch the repo, and CodeBuild does the work with its own IAM roles:
#
#   push to main -> Source -> Build (arm64): pytest with the real model, build the
#   worker image, parity gate inside that image, push :<sha> to ECR
#   -> Deploy: terraform apply infra/app, smoke test the live system, and on
#   failure move both Lambda aliases back to the versions that were live.
#
#   scripts/tf.sh -chdir=infra/cicd init -backend-config=bucket=holopaint-tfstate-<account-id>
#   scripts/tf.sh -chdir=infra/cicd apply
#
# After the first apply the GitHub connection is PENDING: finish the handshake once
# in the console (Developer Tools > Settings > Connections > Update pending connection).

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    key          = "cicd/terraform.tfstate"
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
      Stack     = "cicd"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_ecr_repository" "worker" {
  name = "holopaint-worker"
}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  name         = "holopaint"
  state_bucket = "${local.name}-tfstate-${local.account_id}"
  model_bucket = "${local.name}-models-${local.account_id}"
  arn          = "${var.region}:${local.account_id}"
  # Only changes that reach AWS start the pipeline; the web page and docs don't.
  deploy_paths = [
    "worker/**", "api/**", "infra/app/**", "infra/modules/**", "ci/**",
    "model/parity_gate.py", "scripts/cd_deploy.sh", "scripts/smoke_test.py",
  ]
}

resource "aws_codeconnections_connection" "github" {
  name          = "${local.name}-github"
  provider_type = "GitHub"
}

module "artifacts" {
  source            = "../modules/private_bucket"
  name              = "${local.name}-pipeline-${local.account_id}"
  expire_after_days = 14
  force_destroy     = true # only pipeline hand-offs live here
}

resource "aws_cloudwatch_log_group" "build" {
  for_each          = toset(["build", "deploy"])
  name              = "/aws/codebuild/${local.name}-${each.key}"
  retention_in_days = 14
}

# Build: arm64 like the Lambda, privileged for Docker.
resource "aws_codebuild_project" "build" {
  name          = "${local.name}-build"
  description   = "Tests, worker image, parity gate inside the image, push to ECR"
  service_role  = aws_iam_role.build.arn
  build_timeout = 40

  source {
    type      = "CODEPIPELINE"
    buildspec = "ci/build.yml"
  }
  artifacts {
    type = "CODEPIPELINE"
  }
  environment {
    type            = "ARM_CONTAINER"
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    privileged_mode = true

    environment_variable {
      name  = "MODEL_BUCKET"
      value = local.model_bucket
    }
    environment_variable {
      name  = "ECR_REPOSITORY"
      value = data.aws_ecr_repository.worker.repository_url
    }
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build["build"].name
    }
  }
}

resource "aws_codebuild_project" "deploy" {
  name          = "${local.name}-deploy"
  description   = "terraform apply infra/app, smoke test, roll the aliases back on failure"
  service_role  = aws_iam_role.deploy.arn
  build_timeout = 30

  source {
    type      = "CODEPIPELINE"
    buildspec = "ci/deploy.yml"
  }
  artifacts {
    type = "CODEPIPELINE"
  }
  environment {
    type         = "ARM_CONTAINER"
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = "aws/codebuild/amazonlinux-aarch64-standard:3.0"

    environment_variable {
      name  = "STATE_BUCKET"
      value = local.state_bucket
    }
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build["deploy"].name
    }
  }
}

resource "aws_codepipeline" "this" {
  name           = local.name
  role_arn       = aws_iam_role.pipeline.arn
  pipeline_type  = "V2"
  execution_mode = "QUEUED" # one deploy at a time, in commit order

  artifact_store {
    location = module.artifacts.id
    type     = "S3"
  }

  trigger {
    provider_type = "CodeStarSourceConnection"
    git_configuration {
      source_action_name = "Source"
      push {
        branches {
          includes = ["main"]
        }
        file_paths {
          includes = local.deploy_paths
        }
      }
    }
  }

  stage {
    name = "Source"
    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "SourceVariables"
      output_artifacts = ["source"]
      configuration = {
        ConnectionArn    = aws_codeconnections_connection.github.arn
        FullRepositoryId = var.github_repository
        BranchName       = "main"
      }
    }
  }

  stage {
    name = "Build"
    action {
      name            = "TestBuildGate"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      namespace       = "BuildVariables"
      input_artifacts = ["source"]
      configuration = {
        ProjectName = aws_codebuild_project.build.name
        EnvironmentVariables = jsonencode([
          { name = "COMMIT_ID", value = "#{SourceVariables.CommitId}", type = "PLAINTEXT" },
        ])
      }
    }
  }

  stage {
    name = "Deploy"
    action {
      name            = "ApplySmokeRollback"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["source"]
      configuration = {
        ProjectName = aws_codebuild_project.deploy.name
        EnvironmentVariables = jsonencode([
          { name = "COMMIT_ID", value = "#{SourceVariables.CommitId}", type = "PLAINTEXT" },
          { name = "IMAGE_TAG", value = "#{BuildVariables.IMAGE_TAG}", type = "PLAINTEXT" },
          { name = "MODEL_VERSION", value = "#{BuildVariables.MODEL_VERSION}", type = "PLAINTEXT" },
        ])
      }
    }
  }
}
