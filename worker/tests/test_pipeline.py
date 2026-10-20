"""
Golden test for the ONNX pipeline. The golden outline was produced by the INT8
model on Apple Silicon; other CPUs (e.g. Lambda's Graviton) may round slightly
differently, so the bar is the same IoU the parity gate uses, not equality.

    UPDATE_GOLDEN=1 .venv/bin/python -m pytest worker/tests/test_pipeline.py
"""

import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from conftest import MODEL, needs_model, shapes_image
from onnx_predictor import OnnxPredictor
from pipeline import DEFAULT_THRESHOLD, DETAIL_THRESHOLDS, colouring_page, detail_outlines, suggested_detail

GOLDEN = Path(__file__).parent / "golden" / "shapes_outline.png"
MIN_IOU = 0.97


@pytest.fixture(scope="module")
def predictor():
    return OnnxPredictor(str(MODEL))


def edge_iou(a: np.ndarray, b: np.ndarray) -> float:
    ea, eb = a == 0, b == 0
    return np.count_nonzero(ea & eb) / np.count_nonzero(ea | eb)


@needs_model
def test_matches_golden_outline(predictor):
    outline = colouring_page(shapes_image(), predictor).outline
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.parent.mkdir(exist_ok=True)
        cv2.imwrite(str(GOLDEN), outline)
    golden = cv2.imread(str(GOLDEN), cv2.IMREAD_GRAYSCALE)
    assert golden is not None, f"missing {GOLDEN}; run with UPDATE_GOLDEN=1"
    assert outline.shape == golden.shape
    assert edge_iou(outline, golden) >= MIN_IOU


@needs_model
def test_outline_is_pure_black_on_white(predictor):
    outline = colouring_page(shapes_image(), predictor).outline
    assert set(np.unique(outline)) <= {0, 255}
    assert np.count_nonzero(outline == 0) > 0


@needs_model
def test_small_images_skip_tiling(predictor):
    result = colouring_page(shapes_image(200, 150), predictor)
    assert result.outline.shape == (150, 200)
    assert result.tiles == 0


@needs_model
def test_batch_size_does_not_change_output(predictor):
    image = shapes_image()
    one = colouring_page(image, predictor, batch_size=1).outline
    eight = colouring_page(image, predictor, batch_size=8).outline
    assert edge_iou(one, eight) >= 0.999


@needs_model
def test_detail_levels_share_one_model_pass(predictor):
    image = shapes_image()
    result = colouring_page(image, predictor)
    outlines = detail_outlines(image, result.probability)
    assert len(outlines) == len(DETAIL_THRESHOLDS) and DETAIL_THRESHOLDS[-1] == DEFAULT_THRESHOLD
    assert np.array_equal(outlines[-1], result.outline)  # the top level is exactly HoloDraw's output
    ink = [np.count_nonzero(o == 0) for o in outlines]
    assert ink == sorted(ink)


def test_suggested_detail_is_the_densest_colourable_level():
    def page(ink_share):
        outline = np.full((100, 100), 255, np.uint8)
        outline.flat[: int(ink_share * outline.size)] = 0
        return outline

    assert suggested_detail([page(0.02), page(0.1), page(0.3)]) == 1
    assert suggested_detail([page(0.02), page(0.1), page(0.15)]) == 2
    assert suggested_detail([page(0.25), page(0.4)]) == 0
