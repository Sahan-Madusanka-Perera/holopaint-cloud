# One dashboard and five alarms for the pipeline. Alarms publish to an SNS topic;
# set alarm_email to have it mail you (the address must confirm the subscription).
#
#   dlq           a job failed three times and landed in the dead-letter queue
#   backlog       the oldest upload has waited longer than backlog_seconds
#   worker-errors the worker crashed (not a rejected photo, which is handled)
#   jobs-failed   the worker hit transient errors that SQS is retrying
#   api-5xx       the API answered with a server error

locals {
  worker_metrics = { namespace = "HoloPaint", dimensions = { service = "worker" } }
  alarms = {
    dlq = {
      description = "A job failed every attempt and is in the dead-letter queue."
      namespace   = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", stat = "Maximum", threshold = 0
      dimensions  = { QueueName = var.dlq_name }
    }
    backlog = {
      description = "The oldest upload has waited more than ${var.backlog_seconds} s for a worker."
      namespace   = "AWS/SQS", metric = "ApproximateAgeOfOldestMessage", stat = "Maximum", threshold = var.backlog_seconds
      dimensions  = { QueueName = var.queue_name }
    }
    worker-errors = {
      description = "The worker Lambda crashed."
      namespace   = "AWS/Lambda", metric = "Errors", stat = "Sum", threshold = 0
      dimensions  = { FunctionName = var.worker_function }
    }
    jobs-failed = {
      description = "The worker hit errors that SQS is retrying."
      namespace   = local.worker_metrics.namespace, metric = "JobsFailed", stat = "Sum", threshold = 0
      dimensions  = local.worker_metrics.dimensions
    }
    api-5xx = {
      description = "The API returned server errors."
      namespace   = "AWS/ApiGateway", metric = "5xx", stat = "Sum", threshold = 0
      dimensions  = { ApiId = var.api_id, Stage = "$default" }
    }
  }
}

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.stat
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching" # no traffic is not a fault
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "Worker time per photo (ms)"
          region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["HoloPaint", "JobLatency", "service", "worker", { stat = "p50", label = "p50" }],
            ["...", { stat = "p95", label = "p95" }],
            ["...", { stat = "Maximum", label = "max" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "Photos per minute"
          region = var.region, view = "timeSeries", stat = "Sum", period = 60
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", var.queue_name, { label = "uploaded" }],
            ["AWS/SQS", "NumberOfMessagesDeleted", "QueueName", var.queue_name, { label = "finished" }],
            ["HoloPaint", "JobsRejected", "service", "worker", { label = "rejected photos" }],
            ["HoloPaint", "JobsFailed", "service", "worker", { label = "failed attempts" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Queue"
          region = var.region, view = "timeSeries", stat = "Maximum", period = 60
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.queue_name, { label = "waiting" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesNotVisible", "QueueName", var.queue_name, { label = "in progress" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.dlq_name, { label = "dead-letter" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.queue_name, { label = "oldest wait (s)", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Worker Lambda"
          region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", var.worker_function, { stat = "Maximum", label = "running" }],
            ["AWS/Lambda", "Errors", "FunctionName", var.worker_function, { stat = "Sum", label = "errors" }],
            ["HoloPaint", "ColdStart", "function_name", var.worker_function, "service", "worker", { stat = "Sum", label = "cold starts" }],
            ["AWS/Lambda", "Duration", "FunctionName", var.worker_function, { stat = "p95", label = "duration p95 (ms)", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "API"
          region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", var.api_id, "Stage", "$default", { stat = "Sum", label = "requests" }],
            ["AWS/ApiGateway", "4xx", "ApiId", var.api_id, "Stage", "$default", { stat = "Sum", label = "4xx (incl. throttled)" }],
            ["AWS/ApiGateway", "5xx", "ApiId", var.api_id, "Stage", "$default", { stat = "Sum", label = "5xx" }],
            ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, "Stage", "$default", { stat = "p95", label = "latency p95 (ms)", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 18, width = 12, height = 6
        properties = {
          title  = "Upload to worker (ms)"
          region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["HoloPaint", "DeliveryDelay", "service", "worker", { stat = "p50", label = "S3 event to worker, p50" }],
            ["...", { stat = "p95", label = "S3 event to worker, p95" }],
            ["HoloPaint", "QueueDelay", "service", "worker", { stat = "p95", label = "in SQS, p95" }],
          ]
        }
      },
      {
        type = "alarm", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "Alarms"
          alarms = [for alarm in aws_cloudwatch_metric_alarm.this : alarm.arn]
        }
      },
    ]
  })
}
