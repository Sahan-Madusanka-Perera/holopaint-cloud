variable "region" {
  type        = string
  default     = "ap-southeast-2"
  description = "Fixed by AWS for this Project account; other regions are denied."
}

variable "github_repository" {
  type        = string
  default     = "Sahan-Madusanka-Perera/holopaint-cloud"
  description = "owner/name of the repository the pipeline deploys from."
}
