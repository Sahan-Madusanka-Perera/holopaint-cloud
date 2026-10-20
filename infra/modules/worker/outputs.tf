output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "version" {
  value = aws_lambda_function.this.version
}

output "alias_arn" {
  value = aws_lambda_alias.live.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}
