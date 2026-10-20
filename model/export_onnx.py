"""
Export the PyTorch U-Net to ONNX (FP32) and check it against PyTorch.

Input  "image": (batch, 3, 256, 256) float32, ImageNet-normalised RGB
Output "edges": (batch, 1, 256, 256) float32 in [0, 1]

    .venv/bin/python model/export_onnx.py
"""

import cv2
import numpy as np
import onnx
import onnxruntime as ort
import torch

from common import ONNX_FP32, WEIGHTS, parity_images
from pipeline import TILE, to_tensor
from unet import load_unet

OPSET = 17


def main() -> None:
    model = load_unet(str(WEIGHTS))
    dummy = torch.zeros(1, 3, TILE, TILE)

    torch.onnx.export(
        model,
        dummy,
        str(ONNX_FP32),
        input_names=["image"],
        output_names=["edges"],
        dynamic_axes={"image": {0: "batch"}, "edges": {0: "batch"}},
        opset_version=OPSET,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(str(ONNX_FP32)))

    # Compare raw model outputs on real tiles (batch of 4 exercises the dynamic axis).
    images = [cv2.resize(cv2.imread(str(p)), (TILE, TILE)) for p in parity_images(4, 0)]
    batch = np.stack([to_tensor(img) for img in images])
    with torch.inference_mode():
        expected = model(torch.from_numpy(batch)).numpy()
    session = ort.InferenceSession(str(ONNX_FP32), providers=["CPUExecutionProvider"])
    (actual,) = session.run(None, {"image": batch})

    max_abs = float(np.abs(expected - actual).max())
    size_mb = ONNX_FP32.stat().st_size / 1e6
    print(f"wrote {ONNX_FP32.name} ({size_mb:.1f} MB), opset {OPSET}")
    print(f"max |PyTorch - ONNX| on 4 tiles: {max_abs:.2e}")
    assert max_abs < 1e-4, "ONNX export diverges from PyTorch"


if __name__ == "__main__":
    main()
