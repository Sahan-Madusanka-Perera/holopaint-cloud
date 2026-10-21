# One role per stage, each allowed only what its stage does: the pipeline moves
# artifacts and starts builds; Build reads the model registry and pushes images;
# Deploy owns the app stack's state and resources, and nothing else.

data "aws_iam_policy_document" "assume" {
  for_each = toset(["codepipeline", "codebuild"])
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["${each.key}.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# Pipeline

resource "aws_iam_role" "pipeline" {
  name               = "${local.name}-cicd-pipeline"
  assume_role_policy = data.aws_iam_policy_document.assume["codepipeline"].json
}

data "aws_iam_policy_document" "pipeline" {
  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:GetBucketVersioning", "s3:GetBucketLocation"]
    resources = [module.artifacts.arn, "${module.artifacts.arn}/*"]
  }
  statement {
    sid       = "Repository"
    actions   = ["codeconnections:UseConnection", "codestar-connections:UseConnection"]
    resources = [aws_codeconnections_connection.github.arn]
  }
  statement {
    sid       = "Builds"
    actions   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"]
    resources = [aws_codebuild_project.build.arn, aws_codebuild_project.deploy.arn]
  }
}

resource "aws_iam_role_policy" "pipeline" {
  name   = "${local.name}-cicd-pipeline"
  role   = aws_iam_role.pipeline.id
  policy = data.aws_iam_policy_document.pipeline.json
}

# Build

resource "aws_iam_role" "build" {
  name               = "${local.name}-cicd-build"
  assume_role_policy = data.aws_iam_policy_document.assume["codebuild"].json
}

data "aws_iam_policy_document" "build" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.build["build"].arn}:*"]
  }
  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = ["${module.artifacts.arn}/*"]
  }
  statement {
    sid       = "ReadModelAndParitySet"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${local.model_bucket}/models/*", "arn:aws:s3:::${local.model_bucket}/parity/*"]
  }
  statement {
    sid       = "ListParitySet"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.model_bucket}"]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["parity/*"]
    }
  }
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushWorkerImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
    ]
    resources = [data.aws_ecr_repository.worker.arn]
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "${local.name}-cicd-build"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}

# Deploy: Terraform for infra/app. Scoped by name to the app's own resources; the
# IAM statements name the two app roles exactly, so a deploy can't touch these
# CI/CD roles or create new ones.

resource "aws_iam_role" "deploy" {
  name               = "${local.name}-cicd-deploy"
  assume_role_policy = data.aws_iam_policy_document.assume["codebuild"].json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.build["deploy"].arn}:*"]
  }
  statement {
    sid       = "Artifacts"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${module.artifacts.arn}/*"]
  }
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.state_bucket}"]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["app/*"]
    }
  }
  statement {
    sid       = "StateReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${local.state_bucket}/app/*"]
  }
  statement {
    sid       = "MediaBucket"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::${local.name}-media-${local.account_id}", "arn:aws:s3:::${local.name}-media-${local.account_id}/*"]
  }
  statement {
    sid       = "QueueTableFunctions"
    actions   = ["sqs:*", "dynamodb:*", "lambda:*"]
    resources = ["arn:aws:sqs:${local.arn}:${local.name}-*", "arn:aws:dynamodb:${local.arn}:table/${local.name}-*", "arn:aws:lambda:${local.arn}:function:${local.name}-*"]
  }
  statement {
    sid = "EventSourceMappings"
    actions = [
      "lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping",
      "lambda:DeleteEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:ListTags", "lambda:TagResource",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "HttpApi"
    actions   = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]
    resources = ["arn:aws:apigateway:${var.region}::/apis", "arn:aws:apigateway:${var.region}::/apis/*", "arn:aws:apigateway:${var.region}::/tags/*"]
  }
  statement {
    sid = "AppRoles"
    actions = [
      "iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:PutRolePolicy", "iam:GetRolePolicy",
      "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.name}-api", "arn:aws:iam::${local.account_id}:role/${local.name}-worker"]
  }
  statement {
    sid       = "PassAppRolesToLambda"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.name}-api", "arn:aws:iam::${local.account_id}:role/${local.name}-worker"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
  statement {
    sid       = "FunctionLogs"
    actions   = ["logs:*"]
    resources = ["arn:aws:logs:${local.arn}:log-group:/aws/lambda/${local.name}-*", "arn:aws:logs:${local.arn}:log-group:/aws/lambda/${local.name}-*:*"]
  }
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "WorkerImage"
    actions   = ["ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:ListTagsForResource"]
    resources = [data.aws_ecr_repository.worker.arn]
  }
}

resource "aws_iam_policy" "deploy" {
  name   = "${local.name}-cicd-deploy"
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}
