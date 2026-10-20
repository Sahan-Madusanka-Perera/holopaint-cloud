"""
Parity evaluation: does a compressed model still draw the same colouring pages?

Runs the full pipeline with the PyTorch reference and with each ONNX candidate
on the fixed parity set, then reports per candidate:
  - outline IoU vs PyTorch (edge pixels, 2 px frame excluded), mean and worst
  - mean absolute error of the blended edge-probability map
  - end-to-end seconds per photo (median), split into small and HD photos,
    at a Lambda-like thread count
Also writes side-by-side PNGs (reference | candidate) for the worst image
and one HD image of the gated candidate, for a visual check.

    .venv/bin/python model/parity_eval.py
    .venv/bin/python model/parity_eval.py --gate unet_int8_static.onnx --min-iou 0.97
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from common import ARTIFACTS, RESULTS, WEIGHTS, TorchPredictor, parity_images
from onnx_predictor import OnnxPredictor
from pipeline import colouring_page

CANDIDATES = ["unet_fp32.onnx", "unet_int8_dynamic.onnx", "unet_int8_static.onnx"]
FRAME = 2  # pipeline draws a 2 px border on every outline; identical, so exclude it
HD_PIXELS = 500_000  # BSDS500 is 481x321 (0.15 MP); BIPED is 1280x720 (0.92 MP)


def edge_iou(reference: np.ndarray, candidate: np.ndarray) -> float:
    a = reference[FRAME:-FRAME, FRAME:-FRAME] == 0
    b = candidate[FRAME:-FRAME, FRAME:-FRAME] == 0
    union = np.count_nonzero(a | b)
    return 1.0 if union == 0 else np.count_nonzero(a & b) / union


def run(predictor, images, batch_size):
    colouring_page(images[0][1], predictor, batch_size=batch_size)  # warm-up
    results, seconds = [], []
    for _, image in images:
        start = time.perf_counter()
        results.append(colouring_page(image, predictor, batch_size=batch_size))
        seconds.append(time.perf_counter() - start)
    return results, seconds


def size_mb(path: Path) -> float:
    return path.stat().st_size / 2**20


def timing(images, seconds) -> dict:
    hd = [s for (_, img), s in zip(images, seconds) if img.shape[0] * img.shape[1] >= HD_PIXELS]
    small = [s for (_, img), s in zip(images, seconds) if img.shape[0] * img.shape[1] < HD_PIXELS]
    return {"sec_small": float(np.median(small)), "sec_hd": float(np.median(hd))}


def save_side_by_side(name: str, reference: np.ndarray, candidate: np.ndarray) -> None:
    gap = np.full((reference.shape[0], 16), 255, dtype=np.uint8)
    cv2.imwrite(str(RESULTS / name), np.hstack([reference, gap, candidate]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--threads", type=int, default=2, help="Lambda gets ~2 vCPUs at 3008 MB")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--n-bsds", type=int, default=20)
    parser.add_argument("--n-biped", type=int, default=10)
    parser.add_argument("--gate", help="candidate file that must pass --min-iou")
    parser.add_argument("--min-iou", type=float, default=0.97)
    args = parser.parse_args()

    paths = parity_images(args.n_bsds, args.n_biped)
    images = [(p, cv2.imread(str(p))) for p in paths]
    print(f"parity set: {len(images)} images, {args.threads} threads, batch {args.batch_size}")

    reference, ref_seconds = run(TorchPredictor(threads=args.threads), images, args.batch_size)
    rows = [{
        "model": WEIGHTS.name, "size_mb": size_mb(WEIGHTS),
        "iou_mean": 1.0, "iou_min": 1.0, "prob_mae": 0.0, **timing(images, ref_seconds),
    }]
    RESULTS.mkdir(exist_ok=True)

    per_image = {}
    for name in CANDIDATES:
        path = ARTIFACTS / name
        if not path.exists():
            print(f"skip {name}: not built")
            continue
        results, seconds = run(OnnxPredictor(str(path), threads=args.threads), images, args.batch_size)
        ious = [edge_iou(r.outline, c.outline) for r, c in zip(reference, results)]
        maes = [float(np.abs(r.probability - c.probability).mean()) for r, c in zip(reference, results)]
        per_image[name] = {p.name: round(iou, 4) for (p, _), iou in zip(images, ious)}
        rows.append({
            "model": name, "size_mb": size_mb(path),
            "iou_mean": float(np.mean(ious)), "iou_min": float(np.min(ious)), "prob_mae": float(np.mean(maes)),
            **timing(images, seconds),
        })
        if name == args.gate:
            worst = int(np.argmin(ious))
            hd = next(i for i, (_, img) in enumerate(images) if img.shape[0] * img.shape[1] >= HD_PIXELS)
            for label, i in [("worst", worst), ("hd", hd)]:
                save_side_by_side(f"compare_{label}_{images[i][0].stem}.png", reference[i].outline, results[i].outline)

    report = {"images": [p.name for p in paths], "threads": args.threads, "rows": rows, "per_image_iou": per_image}
    (RESULTS / "parity.json").write_text(json.dumps(report, indent=2))

    lines = [
        "| model | size (MB) | outline IoU mean | IoU worst | prob. MAE | s/photo 481x321 | s/photo 1280x720 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        lines.append(
            f"| {r['model']} | {r['size_mb']:.1f} | {r['iou_mean']:.4f} | {r['iou_min']:.4f} "
            f"| {r['prob_mae']:.5f} | {r['sec_small']:.2f} | {r['sec_hd']:.2f} |"
        )
    table = "\n".join(lines)
    (RESULTS / "parity.md").write_text(table + "\n")
    print(table)

    if args.gate:
        row = next((r for r in rows if r["model"] == args.gate), None)
        if row is None or row["iou_min"] < args.min_iou:
            worst = "missing" if row is None else f"{row['iou_min']:.4f}"
            print(f"GATE FAIL: {args.gate} worst IoU {worst} < {args.min_iou}")
            return 1
        print(f"GATE PASS: {args.gate} worst IoU {row['iou_min']:.4f} >= {args.min_iou}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
