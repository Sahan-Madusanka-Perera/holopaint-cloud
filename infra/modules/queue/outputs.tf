output "arn" {
  value = aws_sqs_queue.this.arn
}

output "url" {
  value = aws_sqs_queue.this.id
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.id
}

output "max_receive_count" {
  value = var.max_receive_count
}

# The bucket notification must wait for this, or S3's test message is refused.
output "policy_id" {
  value = aws_sqs_queue_policy.this.id
}
