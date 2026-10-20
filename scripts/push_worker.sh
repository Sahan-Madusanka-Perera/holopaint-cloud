#!/usr/bin/env bash
# Build the worker image for arm64 and push it to ECR under an immutable tag.
# Prints the tag and model version to pass to Terraform.
#   scripts/push_worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="${AWS_PROFILE:-holopaint}"
REGION=ap-southeast-2
MODEL=artifacts/unet_int8_static.onnx

ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
REPO="$REGISTRY/holopaint-worker"

TAG="$(git rev-parse --short=12 HEAD)"
if [[ -n "$(git status --porcelain -- worker api "$MODEL")" ]]; then
  TAG="$TAG-dirty-$(date +%s)"  # never reuse a clean SHA tag for uncommitted code
fi
MODEL_VERSION="int8-static-$(shasum -a 256 "$MODEL" | cut -c1-12)"

aws ecr get-login-password --profile "$PROFILE" --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

# --provenance/--sbom off: Lambda rejects image indexes that carry attestations.
docker build --platform linux/arm64 --provenance=false --sbom=false \
  --build-arg MODEL_VERSION="$MODEL_VERSION" -f worker/Dockerfile -t "$REPO:$TAG" . >&2
docker push "$REPO:$TAG" >&2

echo "worker_image_tag=$TAG"
echo "model_version=$MODEL_VERSION"
