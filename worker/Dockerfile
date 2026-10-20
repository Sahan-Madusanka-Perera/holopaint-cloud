# Worker Lambda image for arm64 (Graviton). Build from the repo root:
#   docker build --platform linux/arm64 -f worker/Dockerfile -t holopaint-worker .
ARG PYTHON=3.12

FROM public.ecr.aws/lambda/python:${PYTHON} AS deps
COPY worker/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --target /deps -r /tmp/requirements.txt

FROM public.ecr.aws/lambda/python:${PYTHON}
# The base image lags behind Amazon Linux security fixes (ECR's scan found HIGH
# CVEs in openssl, pcre2, curl, rpm), so apply them at build time.
RUN dnf upgrade -y && dnf clean all && rm -rf /var/cache/dnf
COPY --from=deps /deps ${LAMBDA_TASK_ROOT}
COPY worker/handler.py worker/photo.py worker/pipeline.py worker/onnx_predictor.py ${LAMBDA_TASK_ROOT}/
COPY artifacts/unet_int8_static.onnx /opt/model/model.onnx
ARG MODEL_VERSION=dev
ENV MODEL_PATH=/opt/model/model.onnx \
    MODEL_VERSION=${MODEL_VERSION}
CMD ["handler.lambda_handler"]
