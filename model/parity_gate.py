"""
Parity gate for CD: does the model in this image still draw the same colouring
pages as the original PyTorch model? Runs inside the worker image, on Graviton
in CodeBuild, so it checks exactly what will ship:

    docker run --rm --entrypoint python3 -e PYTHONPATH=/var/task \
      -v "$PWD/parity:/parity:ro" -v "$PWD/model/parity_gate.py:/gate/parity_gate.py:ro" \
      holopaint-worker:<tag> /gate/parity_gate.py /parity

Locally:  PYTHONPATH=worker .venv/bin/python model/parity_gate.py artifacts/parity \
            --model artifacts/unet_int8_static.onnx

The bundle comes from model/parity_bundle.py. Exits 1 if any photo's outline IoU
falls below the bundle's bar, or if the bundle doesn't match its manifest.
Needs only the worker's own dependencies: no PyTorch, no weights.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from onnx_predictor import OnnxPredictor
from pipeline import colouring_page

FRAME = 2  # the pipeline draws a 2 px border on every outline; excluded, as in parity_eval.py


def edge_iou(reference: np.ndarray, candidate: np.ndarray) -> float:
    a = reference[FRAME:-FRAME, FRAME:-FRAME] == 0
    b = candidate[FRAME:-FRAME, FRAME:-FRAME] == 0
    union = np.count_nonzero(a | b)
    return 1.0 if union == 0 else np.count_nonzero(a & b) / union


def checked(path: Path, digest: str) -> Path:
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise SystemExit(f"GATE ERROR: {path} does not match the manifest")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--model", default="/opt/model/model.onnx")
    parser.add_argument("--threads", type=int, default=2, help="what the Lambda gets at 3008 MB")
    args = parser.parse_args()

    manifest = json.loads((args.bundle / "manifest.json").read_text())
    bar = manifest["min_iou"]
    predictor = OnnxPredictor(args.model, threads=args.threads)
    started = time.perf_counter()
    rows = []
    for photo in manifest["photos"]:
        image = cv2.imread(str(checked(args.bundle / "images" / photo["name"], photo["image_sha256"])))
        reference = cv2.imread(str(checked(args.bundle / "refs" / photo["name"], photo["ref_sha256"])), cv2.IMREAD_GRAYSCALE)
        iou = edge_iou(reference, colouring_page(image, predictor).outline)
        rows.append((photo["name"], iou))
        print(f"{'ok  ' if iou >= bar else 'FAIL'} {photo['name']:24s} IoU {iou:.4f}")

    ious = [iou for _, iou in rows]
    worst_name, worst = min(rows, key=lambda row: row[1])
    print(f"{len(rows)} photos in {time.perf_counter() - started:.0f} s: mean IoU {np.mean(ious):.4f}, "
          f"worst {worst:.4f} ({worst_name}), bar {bar}")
    if worst < bar:
        print(f"GATE FAIL: {sum(i < bar for i in ious)} photo(s) below {bar}")
        return 1
    print("GATE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
