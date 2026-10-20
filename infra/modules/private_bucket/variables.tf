variable "name" {
  type        = string
  description = "Globally unique bucket name."
}

variable "versioned" {
  type    = bool
  default = false
}

variable "noncurrent_version_days" {
  type        = number
  default     = 30
  description = "How long old object versions are kept when versioning is on."
}

variable "expire_after_days" {
  type        = number
  default     = null
  description = "Delete every object this many days after creation (null = keep)."
}

variable "cors_allowed_origins" {
  type    = list(string)
  default = []
}

variable "cors_allowed_methods" {
  type    = list(string)
  default = ["GET"]
}

variable "force_destroy" {
  type        = bool
  default     = false
  description = "Allow `terraform destroy` to delete a non-empty bucket."
}
