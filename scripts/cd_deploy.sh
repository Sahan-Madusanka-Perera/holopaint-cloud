#!/usr/bin/env bash
# Deploy a gated worker image and the API, then prove the live system works.
# If the smoke test fails, move both Lambdas' "live" aliases back to the versions
# that were serving before, confirm the rollback with a second smoke test, and fail.
#
# Runs in CodeBuild (ci/deploy.yml). Rollback covers code (both functions); an
# infrastructure change that breaks things stays applied and fails the pipeline.
#   scripts/cd_deploy.sh <image-tag> <model-version>
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="$1"
MODEL_VERSION="$2"
PYTHON="${PYTHON:-python3}"

tf() { terraform -chdir=infra/app "$@"; }
live_version() {
  aws lambda get-alias --function-name "$1" --name live --query FunctionVersion --output text 2>/dev/null || true
}

tf init -input=false -no-color -backend-config="bucket=$STATE_BUCKET" >/dev/null

worker_before="$(live_version holopaint-worker)"
api_before="$(live_version holopaint-api)"  # empty until the API's alias first exists
echo "live before deploy: worker v${worker_before:-none}, api v${api_before:-none}"

tf apply -input=false -no-color -auto-approve -var "worker_image_tag=$TAG" -var "model_version=$MODEL_VERSION"
API_URL="$(tf output -raw api_url)"
echo "live after deploy: worker v$(live_version holopaint-worker), api v$(live_version holopaint-api)"

if "$PYTHON" scripts/smoke_test.py "$API_URL"; then
  echo "DEPLOYED $TAG"
  exit 0
fi

echo "SMOKE TEST FAILED: rolling back"
rollback() {
  [[ -n "$2" ]] || return 0
  aws lambda update-alias --function-name "$1" --name live --function-version "$2" >/dev/null
  echo "  $1 live -> v$2"
}
rollback holopaint-worker "$worker_before"
rollback holopaint-api "$api_before"
if "$PYTHON" scripts/smoke_test.py "$API_URL"; then
  echo "ROLLED BACK: the previous release is serving again"
else
  echo "ROLLBACK DID NOT RECOVER: the previous release fails too"
fi
exit 1
