"""
The upload limits live in three places: the presigned POST policy (API), the
worker's own check, and the page that shrinks photos before uploading. Each side's
tests read its own constant back, so a slip in one (5 MB written as 5 KB) passed
every test and reached production, where the CD smoke test caught it and rolled
it back. This pins them together, so the same slip fails in CI instead.
"""

import importlib.util
import re
import sys
from functools import reduce
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "api"))

import app as api  # noqa: E402


def load(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page_constant(name: str) -> int:
    """A `const NAME = 5 * 1024 * 1024;` integer product from web/app.js."""
    match = re.search(rf"^const {name} = ([\d\s*_]+);", (ROOT / "web" / "app.js").read_text(), re.M)
    assert match, f"{name} not found in web/app.js"
    return reduce(lambda a, b: a * b, (int(f.replace("_", "")) for f in match.group(1).split("*")))


def test_upload_limit_agrees_across_api_worker_and_page():
    photo = load(ROOT / "worker" / "photo.py")
    assert api.MAX_UPLOAD_BYTES == photo.MAX_BYTES == page_constant("MAX_UPLOAD_BYTES") == 5 * 1024 * 1024


def test_page_shrinks_photos_to_the_worker_cap():
    photo = load(ROOT / "worker" / "photo.py")
    assert page_constant("MAX_SIDE") == photo.MAX_SIDE
