"""
End-to-end smoke test against the *deployed* API, exactly as a browser uses it:
POST /jobs -> upload to the presigned POST -> poll GET /jobs/{id} -> download.
Also checks that S3 itself rejects an upload that breaks the POST policy.
Exits non-zero on any failure, so CD can roll back on it.

    .venv/bin/python scripts/smoke_test.py https://<api-id>.execute-api.ap-southeast-2.amazonaws.com
    .venv/bin/python scripts/smoke_test.py <api-url> --photo me.jpg
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker" / "tests"))
from fixtures import shapes_image  # noqa: E402


def request(method: str, url: str, body: bytes | None = None, headers: dict | None = None) -> tuple:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def multipart(fields: dict, file_bytes: bytes, content_type: str) -> tuple:
    """S3 presigned POST: policy fields first, Content-Type, then the file last."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in {**fields, "Content-Type": content_type}.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo"\r\n'
                 f"Content-Type: {content_type}\r\n\r\n".encode() + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def create_job(api: str) -> dict:
    status, body = request("POST", f"{api}/jobs")
    assert status == 201, f"POST /jobs -> {status} {body[:200]!r}"
    return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("api_url")
    parser.add_argument("--photo", type=Path)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    api = args.api_url.rstrip("/")

    photo = args.photo.read_bytes() if args.photo else \
        cv2.imencode(".jpg", shapes_image(), [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()
    content_type = "image/png" if photo[:4] == b"\x89PNG" else "image/jpeg"

    # 1. S3 must refuse an upload that breaks the POST policy (not an image/* type)
    job = create_job(api)
    body, headers = multipart(job["upload"]["fields"], b"not an image", "text/plain")
    status, _ = request("POST", job["upload"]["url"], body, headers)
    assert status == 403, f"expected S3 to reject a text/plain upload with 403, got HTTP {status}"
    print("ok   S3 rejects uploads that break the POST policy")

    # 2. the real flow
    started = time.perf_counter()
    job = create_job(api)
    body, headers = multipart(job["upload"]["fields"], photo, content_type)
    status, response = request("POST", job["upload"]["url"], body, headers)
    assert status == 204, f"upload -> {status} {response[:300]!r}"
    uploaded = time.perf_counter()
    print(f"ok   uploaded {len(photo) / 1024:.0f} KB as job {job['job_id']}")

    deadline = time.time() + args.timeout
    while True:
        status, response = request("GET", f"{api}/jobs/{job['job_id']}")
        assert status == 200, f"GET job -> {status}"
        state = json.loads(response)
        if state["status"] in ("DONE", "FAILED") or time.time() > deadline:
            break
        time.sleep(1)
    total = time.perf_counter() - started
    assert state["status"] == "DONE", f"job ended {state['status']}: {state.get('error')}"

    status, png = request("GET", state["result_url"])
    assert status == 200 and png[:4] == b"\x89PNG", f"result download -> {status}"
    out = ROOT / "results" / "smoke_outline.png"
    out.write_bytes(png)
    print(f"ok   DONE {state['width']}x{state['height']}, worker {state['duration_ms']} ms, "
          f"upload->done {total - (uploaded - started):.1f} s, total {total:.1f} s -> {out.relative_to(ROOT)}")

    # 3. API input validation
    assert request("GET", f"{api}/jobs/not-a-job")[0] == 400
    assert request("GET", f"{api}/jobs/{'0' * 32}")[0] == 404
    print("ok   API rejects malformed and unknown job ids")
    print("PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print(f"FAIL {exc}")
        sys.exit(1)
