variable "region" {
  type        = string
  default     = "ap-southeast-2"
  description = "Fixed by AWS for this Project account; other regions are denied."
}

variable "worker_image_tag" {
  type        = string
  description = "Immutable ECR tag of the worker image (git SHA), from scripts/push_worker.sh."
}

variable "model_version" {
  type        = string
  description = "Recorded on every job, e.g. int8-static-<sha256 prefix>."
}

variable "allowed_origins" {
  type        = list(string)
  description = "Browser origins allowed by API and bucket CORS."
  default = [
    "http://localhost:8000",
    "https://sahan-madusanka-perera.github.io",
  ]
}

variable "worker_memory_mb" {
  type    = number
  default = 3008
}

variable "worker_ort_threads" {
  type    = number
  default = 2
}

variable "worker_timeout_seconds" {
  type    = number
  default = 120
}

variable "worker_max_concurrency" {
  type    = number
  default = 2
}

variable "api_rate_limit" {
  type    = number
  default = 5
}

variable "api_burst_limit" {
  type    = number
  default = 10
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Mail CloudWatch alarms here; the address must confirm the subscription. Empty: no mail."
}
