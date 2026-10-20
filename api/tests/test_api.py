import json
import os
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
for var, value in {
    "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "AWS_SESSION_TOKEN": "testing",
    "AWS_DEFAULT_REGION": "ap-southeast-2", "TABLE_NAME": "holopaint-jobs", "BUCKET_NAME": "holopaint-test",
}.items():
    os.environ[var] = value
os.environ.pop("AWS_PROFILE", None)

import app as handler  # noqa: E402


@pytest.fixture
def table():
    with mock_aws():
        for cached in (handler._s3, handler._jobs):
            cached.cache_clear()
        boto3.client("s3").create_bucket(
            Bucket="holopaint-test", CreateBucketConfiguration={"LocationConstraint": "ap-southeast-2"})
        boto3.client("dynamodb").create_table(
            TableName="holopaint-jobs", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "job_id", "AttributeType": "S"}])
        yield boto3.resource("dynamodb").Table("holopaint-jobs")
        for cached in (handler._s3, handler._jobs):
            cached.cache_clear()


def call(route: str, job_id: str | None = None) -> tuple:
    event = {"routeKey": route}
    if job_id is not None:
        event["pathParameters"] = {"job_id": job_id}
    response = handler.lambda_handler(event, None)
    return response["statusCode"], json.loads(response["body"])


def test_create_job_returns_size_limited_presigned_post(table):
    status, body = call("POST /jobs")

    assert status == 201
    job_id = body["job_id"]
    assert table.get_item(Key={"job_id": job_id})["Item"]["status"] == "PENDING"
    fields = body["upload"]["fields"]
    assert fields["key"] == f"uploads/{job_id}"
    policy = json.loads(__import__("base64").b64decode(fields["policy"]))
    assert ["content-length-range", 1, handler.MAX_UPLOAD_BYTES] in policy["conditions"]
    assert ["starts-with", "$Content-Type", "image/"] in policy["conditions"]


def test_job_rows_expire_after_a_day(table):
    _, body = call("POST /jobs")
    item = table.get_item(Key={"job_id": body["job_id"]})["Item"]
    assert item["expires_at"] - item["created_at"] == handler.JOB_TTL_SECONDS


def test_pending_job_has_no_result_url(table):
    _, created = call("POST /jobs")
    status, body = call("GET /jobs/{job_id}", created["job_id"])
    assert status == 200
    assert body["status"] == "PENDING" and "result_url" not in body


def test_done_job_links_to_result_and_hides_internals(table):
    job_id = "f" * 32
    table.put_item(Item={"job_id": job_id, "status": "DONE", "result_key": f"results/{job_id}.png",
                         "width": 640, "height": 480, "model_version": "int8-static-abc"})
    status, body = call("GET /jobs/{job_id}", job_id)
    assert status == 200
    assert body["width"] == 640 and body["result_url"].startswith("https://")
    assert "result_key" not in body and "model_version" not in body


@pytest.mark.parametrize("job_id", ["", "abc", "../../etc", "F" * 32, "g" * 32])
def test_malformed_job_id_is_rejected(table, job_id):
    assert call("GET /jobs/{job_id}", job_id)[0] == 400


def test_unknown_job_is_404(table):
    assert call("GET /jobs/{job_id}", "0" * 32)[0] == 404


def test_unknown_route_is_404(table):
    assert call("DELETE /jobs/{job_id}", "0" * 32)[0] == 404
