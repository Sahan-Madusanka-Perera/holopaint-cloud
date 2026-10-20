"""
Local end-to-end test of the worker *container*, with no AWS account involved.

Starts a moto server (fake S3 + DynamoDB) and the worker image (whose base image
includes the Lambda Runtime Interface Emulator) on a private Docker network,
then: create job row -> upload photo -> invoke with an S3->SQS event -> check the
job is DONE and the PNG exists. Reports cold and warm invocation times.

    .venv/bin/python scripts/local_e2e.py                 # synthetic test image
    .venv/bin/python scripts/local_e2e.py --photo me.jpg  # your own photo
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import boto3
import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker" / "tests"))
from fixtures import shapes_image  # noqa: E402

NETWORK, MOTO, WORKER = "holopaint-e2e", "holopaint-moto", "holopaint-worker"
IMAGE = "holopaint-worker:dev"
MOTO_PORT, WORKER_PORT = 5050, 9000
BUCKET, TABLE, REGION = "holopaint-e2e", "holopaint-jobs", "ap-southeast-2"
FAKE_AWS = {"AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "AWS_REGION": REGION,
            "AWS_DEFAULT_REGION": REGION}


def docker(*args: str, check: bool = True) -> str:
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True).stdout.strip()


def start(build: bool, threads: int) -> None:
    docker("network", "create", NETWORK, check=False)
    docker("run", "-d", "--rm", "--name", MOTO, "--network", NETWORK, "-p", f"{MOTO_PORT}:5000",
           "motoserver/moto:latest")
    if build:
        print("building worker image...")
        subprocess.run(["docker", "build", "--platform", "linux/arm64", "-f", "worker/Dockerfile",
                        "-t", IMAGE, "."], cwd=ROOT, check=True, capture_output=True)
    env = {**FAKE_AWS, "AWS_ENDPOINT_URL": f"http://{MOTO}:5000", "TABLE_NAME": TABLE}
    if threads:
        env["ORT_THREADS"] = str(threads)
    env_args = [arg for k, v in env.items() for arg in ("-e", f"{k}={v}")]
    docker("run", "-d", "--rm", "--name", WORKER, "--network", NETWORK, "-p", f"{WORKER_PORT}:8080",
           "--memory", "3008m", "--cpus", "2", *env_args, IMAGE)


def stop() -> None:
    docker("stop", WORKER, MOTO, check=False)
    docker("network", "rm", NETWORK, check=False)


def fake_aws(service: str, resource: bool = False):
    factory = boto3.resource if resource else boto3.client
    return factory(service, endpoint_url=f"http://localhost:{MOTO_PORT}", region_name=REGION,
                   aws_access_key_id="testing", aws_secret_access_key="testing")


def wait_for_moto(timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            fake_aws("s3").list_buckets()
            return
        except Exception:
            time.sleep(0.5)
    raise TimeoutError("moto server did not start")


def invoke(key: str) -> tuple:
    body = json.dumps({"Records": [{"eventName": "ObjectCreated:Post",
                                    "s3": {"bucket": {"name": BUCKET}, "object": {"key": key}}}]})
    event = {"Records": [{"messageId": uuid.uuid4().hex, "body": body,
                          "attributes": {"ApproximateReceiveCount": "1"}}]}
    request = urllib.request.Request(
        f"http://localhost:{WORKER_PORT}/2015-03-31/functions/function/invocations",
        data=json.dumps(event).encode(), method="POST")
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.loads(response.read())
    return payload, time.perf_counter() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--photo", type=Path, help="defaults to a synthetic test image")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--keep", action="store_true", help="leave containers running")
    parser.add_argument("--threads", type=int, default=2,
                        help="ORT threads; Docker reports every host CPU despite --cpus 2 (0 = ORT default)")
    args = parser.parse_args()

    if args.photo:
        photo = args.photo.read_bytes()
    else:
        photo = cv2.imencode(".jpg", shapes_image(), [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()

    stop()
    try:
        start(build=not args.no_build, threads=args.threads)
        wait_for_moto()
        s3, table = fake_aws("s3"), fake_aws("dynamodb", resource=True)
        s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        table = table.create_table(
            TableName=TABLE, BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "job_id", "AttributeType": "S"}])

        failures = 0
        for label in ["cold", "warm"]:
            job_id = uuid.uuid4().hex
            table.put_item(Item={"job_id": job_id, "status": "PENDING"})
            s3.put_object(Bucket=BUCKET, Key=f"uploads/{job_id}", Body=photo)
            payload, seconds = invoke(f"uploads/{job_id}")
            job = table.get_item(Key={"job_id": job_id})["Item"]
            ok = payload == {"batchItemFailures": []} and job["status"] == "DONE"
            failures += not ok
            print(f"{label:>4}: {seconds:5.2f} s  status={job['status']}  "
                  f"{job.get('width')}x{job.get('height')}  tiles={job.get('tiles')}  "
                  f"worker={job.get('duration_ms')} ms  {job.get('error', '')}")
            if ok:
                out = ROOT / "results" / "e2e_outline.png"
                out.write_bytes(s3.get_object(Bucket=BUCKET, Key=job["result_key"])["Body"].read())

        size_mb = int(docker("image", "inspect", IMAGE, "--format", "{{.Size}}")) / 2**20
        print(f"image: {IMAGE} {size_mb:.0f} MB; output: results/e2e_outline.png")
        print("PASS" if failures == 0 else f"FAIL ({failures})")
        return 1 if failures else 0
    finally:
        if not args.keep:
            stop()


if __name__ == "__main__":
    sys.exit(main())
