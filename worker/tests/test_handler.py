import json
import uuid
from dataclasses import dataclass

import boto3
import cv2
import numpy as np
import pytest
from moto import mock_aws

import handler
from conftest import needs_model

BUCKET = "holopaint-test"
TABLE = "holopaint-jobs"


@dataclass
class FakeContext:
    function_name: str = "holopaint-worker"
    memory_limit_in_mb: int = 3008
    invoked_function_arn: str = "arn:aws:lambda:ap-southeast-2:123456789012:function:holopaint-worker"
    aws_request_id: str = "test-request"


@pytest.fixture
def aws():
    with mock_aws():
        for cached in (handler._s3, handler._jobs):
            cached.cache_clear()
        s3 = boto3.client("s3")
        s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "ap-southeast-2"})
        boto3.client("dynamodb").create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "job_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield s3, boto3.resource("dynamodb").Table(TABLE)
        for cached in (handler._s3, handler._jobs):
            cached.cache_clear()


def new_job(aws, data: bytes | None) -> str:
    s3, table = aws
    job_id = uuid.uuid4().hex
    table.put_item(Item={"job_id": job_id, "status": "PENDING"})
    if data is not None:
        s3.put_object(Bucket=BUCKET, Key=f"uploads/{job_id}", Body=data)
    return job_id


def sqs_event(key: str, receives: int = 1, message_id: str = "msg-1") -> dict:
    body = {"Records": [{
        "eventName": "ObjectCreated:Post",
        "s3": {"bucket": {"name": BUCKET}, "object": {"key": key}},
    }]}
    return {"Records": [{
        "messageId": message_id,
        "body": json.dumps(body),
        "attributes": {"ApproximateReceiveCount": str(receives)},
    }]}


def invoke(event: dict) -> dict:
    return handler.lambda_handler(event, FakeContext())


def status(aws, job_id: str) -> dict:
    return aws[1].get_item(Key={"job_id": job_id})["Item"]


@needs_model
def test_upload_becomes_colouring_page(aws, shapes_jpeg):
    job_id = new_job(aws, shapes_jpeg)

    assert invoke(sqs_event(f"uploads/{job_id}")) == {"batchItemFailures": []}

    job = status(aws, job_id)
    assert job["status"] == "DONE"
    assert (job["width"], job["height"]) == (640, 480)
    png = aws[0].get_object(Bucket=BUCKET, Key=job["result_key"])
    assert png["ContentType"] == "image/png"
    outline = cv2.imdecode(np.frombuffer(png["Body"].read(), np.uint8), cv2.IMREAD_GRAYSCALE)
    assert outline.shape == (480, 640)


@needs_model
def test_every_detail_level_is_written(aws, shapes_jpeg):
    job_id = new_job(aws, shapes_jpeg)
    invoke(sqs_event(f"uploads/{job_id}"))

    job = status(aws, job_id)
    assert len(job["detail_keys"]) == len(handler.DETAIL_THRESHOLDS)
    assert job["detail_keys"][-1] == job["result_key"]  # the most detailed level is HoloDraw's default
    assert 0 <= job["detail"] < len(job["detail_keys"])
    ink = []
    for key in job["detail_keys"]:
        body = aws[0].get_object(Bucket=BUCKET, Key=key)["Body"].read()
        outline = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_GRAYSCALE)
        ink.append(np.count_nonzero(outline == 0))
    assert ink == sorted(ink)  # each level adds lines


@needs_model
def test_duplicate_delivery_is_skipped(aws, shapes_jpeg):
    job_id = new_job(aws, shapes_jpeg)
    invoke(sqs_event(f"uploads/{job_id}"))
    # sentinel: any write by the second delivery would overwrite it
    aws[1].update_item(Key={"job_id": job_id}, UpdateExpression="SET updated_at = :zero",
                       ExpressionAttributeValues={":zero": 0})

    assert invoke(sqs_event(f"uploads/{job_id}")) == {"batchItemFailures": []}
    job = status(aws, job_id)
    assert job["status"] == "DONE" and job["updated_at"] == 0


@needs_model
def test_reprocessing_writes_identical_output(aws, shapes_jpeg):
    job_id = new_job(aws, shapes_jpeg)
    key = f"results/{job_id}.png"
    invoke(sqs_event(f"uploads/{job_id}"))
    first = aws[0].get_object(Bucket=BUCKET, Key=key)["Body"].read()
    first_least = aws[0].get_object(Bucket=BUCKET, Key=f"results/{job_id}-1.png")["Body"].read()

    # e.g. the Lambda crashed after writing the PNG but before marking DONE
    aws[1].update_item(Key={"job_id": job_id}, UpdateExpression="SET #s = :p",
                       ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":p": "PENDING"})
    invoke(sqs_event(f"uploads/{job_id}"))
    assert aws[0].get_object(Bucket=BUCKET, Key=key)["Body"].read() == first
    assert aws[0].get_object(Bucket=BUCKET, Key=f"results/{job_id}-1.png")["Body"].read() == first_least


def test_invalid_upload_fails_job_without_retry(aws):
    job_id = new_job(aws, b"<html>not an image</html>")

    assert invoke(sqs_event(f"uploads/{job_id}")) == {"batchItemFailures": []}

    job = status(aws, job_id)
    assert job["status"] == "FAILED"
    assert "not a supported image" in job["error"]


def test_transient_error_is_retried_then_failed_on_last_attempt(aws):
    job_id = new_job(aws, data=None)  # object missing -> S3 NoSuchKey, not the user's fault

    first = invoke(sqs_event(f"uploads/{job_id}", receives=1))
    assert first == {"batchItemFailures": [{"itemIdentifier": "msg-1"}]}
    assert status(aws, job_id)["status"] == "PROCESSING"

    last = invoke(sqs_event(f"uploads/{job_id}", receives=handler.MAX_RECEIVES))
    assert last == {"batchItemFailures": [{"itemIdentifier": "msg-1"}]}  # -> DLQ
    assert status(aws, job_id)["status"] == "FAILED"


def test_s3_test_event_is_ignored(aws):
    event = {"Records": [{"messageId": "m", "body": json.dumps({"Service": "Amazon S3", "Event": "s3:TestEvent"})}]}
    assert invoke(event) == {"batchItemFailures": []}


@pytest.mark.parametrize("key", ["results/abc.png", "uploads/../etc/passwd", "uploads/NOT-A-JOB-ID"])
def test_keys_outside_uploads_are_ignored(aws, key):
    assert invoke(sqs_event(key)) == {"batchItemFailures": []}


def test_upload_without_job_row_is_ignored(aws, shapes_jpeg):
    aws[0].put_object(Bucket=BUCKET, Key=f"uploads/{'a' * 32}", Body=shapes_jpeg)
    assert invoke(sqs_event(f"uploads/{'a' * 32}")) == {"batchItemFailures": []}


def test_one_bad_message_does_not_fail_the_batch(aws):
    good = new_job(aws, b"junk")  # permanent failure: consumed
    bad = new_job(aws, data=None)  # transient failure: retried
    records = sqs_event(f"uploads/{good}", message_id="ok")["Records"] + \
        sqs_event(f"uploads/{bad}", message_id="retry")["Records"]
    assert invoke({"Records": records}) == {"batchItemFailures": [{"itemIdentifier": "retry"}]}
