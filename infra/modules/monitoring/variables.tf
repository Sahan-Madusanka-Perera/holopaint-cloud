variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "worker_function" {
  type = string
}

variable "api_id" {
  type = string
}

variable "queue_name" {
  type = string
}

variable "dlq_name" {
  type = string
}

variable "backlog_seconds" {
  type        = number
  default     = 300
  description = "Alarm when the oldest upload has waited this long for a worker."
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Mail alarms here (the address must confirm the subscription). Empty: no mail."
}
