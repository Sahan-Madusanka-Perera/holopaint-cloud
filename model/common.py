"""Shared paths, predictors and image sets for the model scripts."""

import os
import sys
from pathlib import Path
from typing import List, Optional

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))  # make `pipeline` importable from model/

ARTIFACTS = ROOT / "artifacts"
RESULTS = ROOT / "results"
WEIGHTS = ARTIFACTS / "holopaint_unet.pth"
ONNX_FP32 = ARTIFACTS / "unet_fp32.onnx"

# BSDS500 / BIPED live in the HoloDraw repo; they are not redistributed here.
HOLODRAW = Path(os.environ.get("HOLODRAW_DIR", "~/Documents/Projects/HoloDraw")).expanduser()
BSDS = HOLODRAW / "data/BSR/BSDS500/data/images"
BIPED_TEST = HOLODRAW / "data/BIPED/edges/imgs/test"


class TorchPredictor:
    """Reference predictor: the original PyTorch U-Net."""

    def __init__(self, weights: Path = WEIGHTS, threads: Optional[int] = None):
        from unet import load_unet

        if threads:
            torch.set_num_threads(threads)
        self.model = load_unet(str(weights))

    def __call__(self, batch: np.ndarray) -> np.ndarray:
        with torch.inference_mode():
            return self.model(torch.from_numpy(np.ascontiguousarray(batch))).numpy()[:, 0]


def parity_images(n_bsds: int = 20, n_biped: int = 10) -> List[Path]:
    """Fixed evaluation set: BSDS500 *test* (481x321) plus BIPED test (1280x720),
    so both small and HD photos are covered. Never used for calibration."""
    bsds = sorted((BSDS / "test").glob("*.jpg"))[:n_bsds]
    biped = sorted(BIPED_TEST.rglob("*.jpg"))[:n_biped]
    images = bsds + biped
    if len(images) < n_bsds + n_biped:
        raise FileNotFoundError(f"expected {n_bsds + n_biped} images under {HOLODRAW}/data, found {len(images)}")
    return images


def calibration_images(n: int = 40) -> List[Path]:
    """BSDS500 *train* images, disjoint from the parity set."""
    images = sorted((BSDS / "train").glob("*.jpg"))[:n]
    if len(images) < n:
        raise FileNotFoundError(f"expected {n} BSDS500 train images under {BSDS}")
    return images
