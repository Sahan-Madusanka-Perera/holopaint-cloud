output "pipeline" {
  value = aws_codepipeline.this.name
}

output "connection_arn" {
  value = aws_codeconnections_connection.github.arn
}

output "connection_status" {
  value       = aws_codeconnections_connection.github.connection_status
  description = "PENDING until the GitHub handshake is finished in the console."
}
