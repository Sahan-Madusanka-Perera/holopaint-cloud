"""
Prove worker/pipeline.py is a faithful port of HoloDraw's EdgeDetector.

Runs HoloDraw's original code and the ported pipeline on the same PyTorch
weights and requires pixel-identical outlines. Needs the HoloDraw repo
(HOLODRAW_DIR, default ~/Documents/Projects/HoloDraw), so it runs locally,
not in CI.

    .venv/bin/python model/check_port.py
"""

import argparse
import contextlib
import importlib.util
import io
import sys

import cv2
import numpy as np

from common import HOLODRAW, WEIGHTS, TorchPredictor, parity_images
from pipeline import DEFAULT_THRESHOLD, colouring_page


def load_original_detector():
    spec = importlib.util.spec_from_file_location("holodraw_edge_detector", HOLODRAW / "edge_detector.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with contextlib.redirect_stdout(io.StringIO()):
        detector = module.EdgeDetector(str(WEIGHTS))
    assert detector.model_type == "unet", f"HoloDraw loaded {detector.model_type}, expected unet"
    return detector


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-bsds", type=int, default=6)
    parser.add_argument("--n-biped", type=int, default=2)
    args = parser.parse_args()

    original = load_original_detector()
    predictor = TorchPredictor()
    failures = 0

    for path in parity_images(args.n_bsds, args.n_biped):
        image = cv2.imread(str(path))
        with contextlib.redirect_stdout(io.StringIO()):
            expected = original.detect_edges(image, threshold=DEFAULT_THRESHOLD)[:, :, 0]
        # batch_size=1 reproduces HoloDraw's one-tile-per-forward call pattern exactly
        actual = colouring_page(image, predictor, batch_size=1).outline

        diff = int(np.count_nonzero(expected != actual))
        status = "identical" if diff == 0 else f"{diff} pixels differ"
        print(f"{path.name:>14}  {image.shape[1]}x{image.shape[0]}  {status}")
        failures += diff != 0

    print("PASS: port is pixel-identical" if failures == 0 else f"FAIL: {failures} image(s) differ")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
