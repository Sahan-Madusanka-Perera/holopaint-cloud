import os
import sys
from pathlib import Path

import cv2
import pytest

WORKER = Path(__file__).resolve().parent.parent
ROOT = WORKER.parent
sys.path.insert(0, str(WORKER))

MODEL = Path(os.environ.get("MODEL_PATH", ROOT / "artifacts" / "unet_int8_static.onnx"))
os.environ["MODEL_PATH"] = str(MODEL)
os.environ.setdefault("TABLE_NAME", "holopaint-jobs")
# moto: fake credentials, and never touch a real AWS account from tests
for var, value in {
    "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_SESSION_TOKEN": "testing", "AWS_DEFAULT_REGION": "ap-southeast-2",
}.items():
    os.environ[var] = value
os.environ.pop("AWS_PROFILE", None)

from fixtures import shapes_image  # noqa: E402  (re-exported for tests)

needs_model = pytest.mark.skipif(not MODEL.exists(), reason=f"model not built: {MODEL}")


@pytest.fixture
def shapes_jpeg() -> bytes:
    ok, buf = cv2.imencode(".jpg", shapes_image(), [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return buf.tobytes()
