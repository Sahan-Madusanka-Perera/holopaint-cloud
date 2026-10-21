output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.this.dashboard_name}"
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
