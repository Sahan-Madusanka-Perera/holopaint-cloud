variable "name" {
  type = string
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "AWS recommends at least 6x the consuming Lambda's timeout."
}

variable "max_receive_count" {
  type        = number
  default     = 3
  description = "Deliveries before a message moves to the DLQ. The worker reads it as MAX_RECEIVES."
}

variable "source_bucket_arn" {
  type        = string
  description = "Only this bucket may send upload events."
}

variable "account_id" {
  type = string
}
