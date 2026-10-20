variable "name" {
  type = string
}

variable "source_file" {
  type        = string
  description = "The API handler (api/app.py); boto3 comes from the Lambda runtime."
}

variable "allowed_origins" {
  type        = list(string)
  description = "Web origins allowed to call the API (CORS)."
}

variable "rate_limit" {
  type        = number
  default     = 5
  description = "Steady-state requests per second across all routes."
}

variable "burst_limit" {
  type    = number
  default = 10
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "bucket_name" {
  type = string
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
