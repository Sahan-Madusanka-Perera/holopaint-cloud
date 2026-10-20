output "state_bucket" {
  value = module.state_bucket.id
}

output "model_registry_bucket" {
  value = module.model_registry.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}
