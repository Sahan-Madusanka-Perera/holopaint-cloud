output "api_url" {
  value = module.api.url
}

output "media_bucket" {
  value = module.media.id
}

output "jobs_table" {
  value = module.jobs_table.name
}

output "queue_url" {
  value = module.queue.url
}

output "dlq_url" {
  value = module.queue.dlq_url
}

output "worker_function" {
  value = module.worker.function_name
}

output "worker_version" {
  value = module.worker.version
}

output "worker_alias_arn" {
  value = module.worker.alias_arn
}

output "api_function" {
  value = module.api.function_name
}

output "api_version" {
  value = module.api.version
}

output "dashboard_url" {
  value = module.monitoring.dashboard_url
}
