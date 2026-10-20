# One row per job, keyed by job_id. Rows expire with the uploads (TTL).
# Provisioned capacity, not on-demand: the always-free allowance covers
# provisioned RCU/WCU only.

resource "aws_dynamodb_table" "this" {
  name           = var.name
  billing_mode   = "PROVISIONED"
  read_capacity  = var.read_capacity
  write_capacity = var.write_capacity
  hash_key       = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }
}
