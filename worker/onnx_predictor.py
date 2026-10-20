"""ONNX Runtime implementation of pipeline.Predictor (used by the Lambda worker)."""

from typing import Optional

import numpy as np
import onnxruntime as ort


class OnnxPredictor:
    def __init__(self, model_path: str, threads: Optional[int] = None):
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads:
            options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def __call__(self, batch: np.ndarray) -> np.ndarray:
        (edges,) = self.session.run(None, {self.input_name: batch.astype(np.float32, copy=False)})
        return edges[:, 0]
