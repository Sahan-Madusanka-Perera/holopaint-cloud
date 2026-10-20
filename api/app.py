"""
API Lambda behind an HTTP API (payload format 2.0).

  POST /jobs           -> create a PENDING job + presigned POST for the photo upload
  GET  /jobs/{job_id}  -> job status; once DONE, a short-lived link to the result

The browser uploads straight to S3, so photos never pass through this function.
The presigned POST policy (unlike a presigned PUT) lets S3 itself enforce the
size limit and the image/* content type.
"""

import functools
import json
import logging
import os
import re
import time
import uuid
from decimal import Decimal

import boto3
from botocore.config import Config

MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # keep in sync with worker/photo.py
UPLOAD_URL_SECONDS = 300
RESULT_URL_SECONDS = 900
JOB_TTL_SECONDS = 24 * 3600  # matches the bucket's 1-day lifecycle rule
JOB_ID = re.compile(r"^[0-9a-f]{32}$")
PUBLIC_FIELDS = ("status", "error", "width", "height", "tiles", "duration_ms", "created_at", "updated_at")

logger = logging.getLogger()
logger.setLevel(logging.INFO)


@functools.cache
def _s3():
    return boto3.client("s3", config=Config(signature_version="s3v4"))


@functools.cache
def _jobs():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


def _response(status: int, body: dict) -> dict:
    def plain(value):
        if isinstance(value, Decimal):
            return int(value) if value == value.to_integral_value() else float(value)
        raise TypeError(type(value))

    return {"statusCode": status, "headers": {"content-type": "application/json"},
            "body": json.dumps(body, default=plain)}


def create_job() -> dict:
    job_id = uuid.uuid4().hex
    now = int(time.time())
    _jobs().put_item(
        Item={"job_id": job_id, "status": "PENDING", "created_at": now, "updated_at": now,
              "expires_at": now + JOB_TTL_SECONDS},
        ConditionExpression="attribute_not_exists(job_id)",
    )
    upload = _s3().generate_presigned_post(
        Bucket=os.environ["BUCKET_NAME"],
        Key=f"uploads/{job_id}",
        Conditions=[["content-length-range", 1, MAX_UPLOAD_BYTES], ["starts-with", "$Content-Type", "image/"]],
        ExpiresIn=UPLOAD_URL_SECONDS,
    )
    logger.info(json.dumps({"event": "job_created", "job_id": job_id}))
    return _response(201, {
        "job_id": job_id,
        "upload": {"url": upload["url"], "fields": upload["fields"], "max_bytes": MAX_UPLOAD_BYTES},
        "status_url": f"/jobs/{job_id}",
    })


def get_job(job_id: str) -> dict:
    if not JOB_ID.match(job_id or ""):
        return _response(400, {"error": "invalid job id"})
    job = _jobs().get_item(Key={"job_id": job_id}).get("Item")
    if job is None:
        return _response(404, {"error": "job not found or expired"})

    body = {"job_id": job_id, **{k: job[k] for k in PUBLIC_FIELDS if k in job}}
    if job["status"] == "DONE":
        body["result_url"] = _s3().generate_presigned_url(
            "get_object",
            Params={"Bucket": os.environ["BUCKET_NAME"], "Key": job["result_key"]},
            ExpiresIn=RESULT_URL_SECONDS,
        )
    return _response(200, body)


def lambda_handler(event, context):
    route = event.get("routeKey")
    if route == "POST /jobs":
        return create_job()
    if route == "GET /jobs/{job_id}":
        return get_job(event.get("pathParameters", {}).get("job_id", ""))
    return _response(404, {"error": "not found"})
