#!/usr/bin/env bash
# Run Terraform with short-lived credentials from `aws login` (no access keys on disk).
#   scripts/tf.sh -chdir=infra/app plan
set -euo pipefail
PROFILE="${AWS_PROFILE:-holopaint}"
if ! creds="$(aws configure export-credentials --profile "$PROFILE" --format env 2>/dev/null)"; then
  echo "No valid session for profile '$PROFILE'. Run: aws login --profile $PROFILE" >&2
  exit 1
fi
eval "$creds"
unset AWS_PROFILE
export AWS_REGION=ap-southeast-2
exec terraform "$@"
