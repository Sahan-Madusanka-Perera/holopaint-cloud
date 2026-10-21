"""
Worker Lambda: SQS (fed by S3 upload events) -> colouring page in S3 + job status in DynamoDB.

Delivery is at-least-once, so processing is idempotent: a job already DONE is
skipped, and re-processing an upload writes byte-identical output to the same key.

Failure handling:
  - InvalidPhoto (bad upload)  -> job FAILED, message consumed; retrying can't help
  - anything else (transient)  -> message reported as a batch item failure and
                                  retried by SQS; on the final attempt the job is
                                  marked FAILED first, so users never wait forever,
                                  and the message then moves to the DLQ
"""

import functools
import json
import os
import re
import time
from datetime import datetime
from urllib.parse import unquote_plus

import boto3
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit

from onnx_predictor import OnnxPredictor
from photo import InvalidPhoto, encode_png, load_photo
from pipeline import DETAIL_THRESHOLDS, detail_outlines, edge_probability, suggested_detail

MODEL_PATH = os.environ.get("MODEL_PATH", "/opt/model/model.onnx")
MODEL_VERSION = os.environ.get("MODEL_VERSION", "dev")
RESULT_PREFIX = os.environ.get("RESULT_PREFIX", "results/")
MAX_RECEIVES = int(os.environ.get("MAX_RECEIVES", "3"))  # must match the queue's redrive maxReceiveCount
JOB_KEY = re.compile(r"^uploads/(?P<job_id>[0-9a-f]{32})$")

logger = Logger(service="holopaint-worker")
metrics = Metrics(namespace="HoloPaint", service="worker")


@functools.cache
def _s3():
    return boto3.client("s3")


@functools.cache
def _jobs():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


@functools.cache
def _predictor() -> OnnxPredictor:
    threads = int(os.environ["ORT_THREADS"]) if os.environ.get("ORT_THREADS") else None
    return OnnxPredictor(MODEL_PATH, threads=threads)


def _workers() -> int:
    return int(os.environ.get("ORT_THREADS") or 2)


def _set_status(job_id: str, status: str, **fields) -> None:
    fields = {"status": status, "updated_at": int(time.time()), **fields}
    names = {f"#{k}": k for k in fields}
    values = {f":{k}": v for k, v in fields.items()}
    _jobs().update_item(
        Key={"job_id": job_id},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ConditionExpression="attribute_exists(job_id)",
    )


def process_upload(bucket: str, key: str) -> None:
    match = JOB_KEY.match(key)
    if not match:
        logger.warning("ignoring object outside uploads/<job_id>", extra={"key": key})
        return
    job_id = match["job_id"]

    job = _jobs().get_item(Key={"job_id": job_id}).get("Item")
    if job is None:
        logger.warning("no job row for upload; ignoring", extra={"job_id": job_id})
        return
    if job["status"] == "DONE":
        logger.info("duplicate delivery of a finished job; skipping", extra={"job_id": job_id})
        return

    _set_status(job_id, "PROCESSING")
    started = time.perf_counter()
    try:
        data = _s3().get_object(Bucket=bucket, Key=key)["Body"].read()
        image = load_photo(data)
    except InvalidPhoto as exc:
        logger.info("rejected upload", extra={"job_id": job_id, "reason": str(exc)})
        _set_status(job_id, "FAILED", error=str(exc))
        metrics.add_metric(name="JobsRejected", unit=MetricUnit.Count, value=1)
        return

    # One model pass, then an outline per detail level. The most detailed level is
    # HoloDraw's default and keeps the plain result key.
    probability, tiles = edge_probability(image, _predictor())
    outlines = detail_outlines(image, probability, workers=_workers())
    result_key = f"{RESULT_PREFIX}{job_id}.png"
    detail_keys = [f"{RESULT_PREFIX}{job_id}-{level}.png" for level in range(1, len(outlines))] + [result_key]
    for key, outline in zip(detail_keys, outlines):
        _s3().put_object(Bucket=bucket, Key=key, Body=encode_png(outline), ContentType="image/png")
    detail = suggested_detail(outlines)

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    height, width = image.shape[:2]
    _set_status(
        job_id, "DONE",
        result_key=result_key, detail_keys=detail_keys, detail=detail, width=width, height=height,
        tiles=tiles, duration_ms=elapsed_ms, model_version=MODEL_VERSION,
    )
    metrics.add_metric(name="JobLatency", unit=MetricUnit.Milliseconds, value=elapsed_ms)
    metrics.add_metric(name="TilesPerImage", unit=MetricUnit.Count, value=tiles)
    logger.info("job done", extra={"job_id": job_id, "ms": elapsed_ms, "size": f"{width}x{height}",
                                   "detail": DETAIL_THRESHOLDS[detail]})


def _s3_objects(body: str):
    """S3 -> SQS message body -> (bucket, key, event time) triples. Skips S3's s3:TestEvent."""
    message = json.loads(body)
    for record in message.get("Records", []):
        if record.get("eventName", "").startswith("ObjectCreated"):
            yield record["s3"]["bucket"]["name"], unquote_plus(record["s3"]["object"]["key"]), record.get("eventTime")


def _record_delivery(uploaded_at: str | None, attributes: dict) -> None:
    """How long an upload took to reach a worker: S3 event -> SQS -> this Lambda
    (DeliveryDelay), and the SQS part of that alone (QueueDelay)."""
    if not uploaded_at:
        return
    try:
        uploaded_ms = datetime.fromisoformat(uploaded_at.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return
    now_ms = time.time() * 1000
    metrics.add_metric(name="DeliveryDelay", unit=MetricUnit.Milliseconds, value=round(now_ms - uploaded_ms))
    if attributes.get("SentTimestamp", "").isdigit():
        metrics.add_metric(name="QueueDelay", unit=MetricUnit.Milliseconds, value=round(now_ms - int(attributes["SentTimestamp"])))


def _fail_job_for_key(key: str, reason: str) -> None:
    match = JOB_KEY.match(key)
    if match:
        try:
            _set_status(match["job_id"], "FAILED", error=reason)
        except Exception:  # best effort: the original error matters more
            logger.exception("could not mark job FAILED")


@metrics.log_metrics(capture_cold_start_metric=True)
@logger.inject_lambda_context
def lambda_handler(event, context):
    failures = []
    for record in event.get("Records", []):
        try:
            for bucket, key, uploaded_at in _s3_objects(record["body"]):
                _record_delivery(uploaded_at, record.get("attributes", {}))
                try:
                    process_upload(bucket, key)
                except Exception:
                    receives = int(record.get("attributes", {}).get("ApproximateReceiveCount", "1"))
                    if receives >= MAX_RECEIVES:
                        _fail_job_for_key(key, "internal error; please try another photo")
                    raise
        except Exception:
            logger.exception("record failed; SQS will retry it", extra={"message_id": record.get("messageId")})
            metrics.add_metric(name="JobsFailed", unit=MetricUnit.Count, value=1)
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}


# In Lambda, load the model during the init phase so the first job doesn't pay for it.
if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
    _predictor()
