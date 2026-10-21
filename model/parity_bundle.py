"""
Freeze the parity set for CD: the 30 parity photos (decoded to PNG, so no JPEG
decoder can differ) and the outline the original PyTorch model draws for each.

The CodeBuild parity gate (model/parity_gate.py) compares the shipped ONNX model
against these references without needing PyTorch, the weights or HoloDraw's data.
The photos are BSDS500/BIPED images, so the bundle goes to the private model
registry, never to git:

    .venv/bin/python model/parity_bundle.py               # -> artifacts/parity/
    aws s3 sync artifacts/parity/ s3://holopaint-models-<account-id>/parity/v1/
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2

from common import ARTIFACTS, WEIGHTS, TorchPredictor, parity_images
from pipeline import DEFAULT_THRESHOLD, colouring_page

MIN_IOU = 0.97  # the gate's bar for every photo; worst measured for INT8 static is 0.982


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ARTIFACTS / "parity")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    (args.out / "images").mkdir(parents=True, exist_ok=True)
    (args.out / "refs").mkdir(parents=True, exist_ok=True)
    predictor = TorchPredictor(threads=args.threads)
    photos = []
    for path in parity_images():
        name = f"{path.stem}.png"
        image = cv2.imread(str(path))
        cv2.imwrite(str(args.out / "images" / name), image)
        cv2.imwrite(str(args.out / "refs" / name), colouring_page(image, predictor).outline)
        photos.append({
            "name": name, "source": path.name, "size": [image.shape[1], image.shape[0]],
            "image_sha256": sha256(args.out / "images" / name), "ref_sha256": sha256(args.out / "refs" / name),
        })
        print(f"{name:24s} {image.shape[1]}x{image.shape[0]}")

    manifest = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference": {"model": WEIGHTS.name, "sha256": sha256(WEIGHTS), "threshold": DEFAULT_THRESHOLD},
        "min_iou": MIN_IOU,
        "photos": photos,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(photos)} photos -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
