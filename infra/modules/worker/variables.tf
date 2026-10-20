variable "name" {
  type = string
}

variable "image_uri" {
  type        = string
  description = "ECR image URI with an immutable tag (git SHA)."
}

variable "model_version" {
  type = string
}

variable "memory_mb" {
  type        = number
  default     = 3008
  description = "3008 MB is about 2 vCPUs, and the cap on many new accounts."
}

variable "ort_threads" {
  type        = number
  default     = 2
  description = "ONNX Runtime threads; must match the vCPUs memory_mb buys (oversubscription measured 3.3x slower)."
}

variable "timeout_seconds" {
  type    = number
  default = 120
}

variable "max_concurrency" {
  type        = number
  default     = 2
  description = "Most concurrent workers SQS may invoke: the cost ceiling (the minimum allowed is 2)."
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "bucket_arn" {
  type = string
}

variable "table_name" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "queue_arn" {
  type = string
}

variable "max_receive_count" {
  type = number
}
