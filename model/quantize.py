"""
Quantise the FP32 ONNX U-Net to INT8.

  static : QDQ INT8, per-channel weights, activation ranges calibrated on tiles
           from BSDS500 *train* images (disjoint from the parity set)
  dynamic: weights-only INT8 (Conv -> ConvInteger), no calibration

    .venv/bin/python model/quantize.py --method all
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_dynamic,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process

from common import ARTIFACTS, ONNX_FP32, calibration_images
from pipeline import TILE, to_tensor

PREPROCESSED = ARTIFACTS / "unet_fp32_pre.onnx"
OUTPUTS = {
    "static": ARTIFACTS / "unet_int8_static.onnx",
    "dynamic": ARTIFACTS / "unet_int8_dynamic.onnx",
}


class TileReader(CalibrationDataReader):
    """Yields what the pipeline actually feeds the model: one global 256x256
    resize plus random full-resolution crops per image."""

    def __init__(self, images, crops_per_image: int = 2, seed: int = 0):
        rng = np.random.default_rng(seed)
        tensors = []
        for path in images:
            image = cv2.imread(str(path))
            tensors.append(to_tensor(cv2.resize(image, (TILE, TILE), interpolation=cv2.INTER_LINEAR)))
            h, w = image.shape[:2]
            for _ in range(crops_per_image):
                y, x = rng.integers(0, h - TILE + 1), rng.integers(0, w - TILE + 1)
                tensors.append(to_tensor(image[y:y + TILE, x:x + TILE]))
        self.count = len(tensors)
        self._feeds = iter({"image": t[None]} for t in tensors)

    def get_next(self):
        return next(self._feeds, None)


def quantise_static(n_images: int) -> Path:
    reader = TileReader(calibration_images(n_images))
    print(f"calibrating on {reader.count} tiles from {n_images} BSDS500 train images")
    quantize_static(
        str(PREPROCESSED),
        str(OUTPUTS["static"]),
        reader,
        quant_format=QuantFormat.QDQ,
        per_channel=True,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=CalibrationMethod.MinMax,
    )
    return OUTPUTS["static"]


def quantise_dynamic() -> Path:
    quantize_dynamic(
        str(PREPROCESSED),
        str(OUTPUTS["dynamic"]),
        weight_type=QuantType.QUInt8,
        op_types_to_quantize=["Conv"],
    )
    return OUTPUTS["dynamic"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", choices=["static", "dynamic", "all"], default="all")
    parser.add_argument("--calib-images", type=int, default=40)
    args = parser.parse_args()

    # Folds BatchNorm into Conv and runs shape inference, as ORT recommends before quantising.
    quant_pre_process(str(ONNX_FP32), str(PREPROCESSED))

    methods = ["static", "dynamic"] if args.method == "all" else [args.method]
    for method in methods:
        out = quantise_static(args.calib_images) if method == "static" else quantise_dynamic()
        print(f"wrote {out.name} ({out.stat().st_size / 2**20:.1f} MB)")


if __name__ == "__main__":
    main()
