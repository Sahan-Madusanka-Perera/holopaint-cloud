"""
Photo -> colouring-page pipeline, ported from HoloDraw's EdgeDetector._detect_unet.

The model is injected as a `Predictor` (a batch of normalised 256x256 tiles in,
edge probabilities out), so the same pipeline runs on PyTorch for reference and
on ONNX Runtime in the Lambda worker. Nothing here imports torch.

Behaviour must stay identical to HoloDraw; model/check_port.py verifies that.
"""

from dataclasses import dataclass
from typing import Callable, List

import cv2
import numpy as np

# Gap bridging needs cv2.ximgproc.thinning (opencv-contrib). HoloDraw silently
# skipped thinning without it, which changes the output, so fail loudly instead.
if not hasattr(cv2, "ximgproc"):
    raise ImportError("opencv-contrib-python(-headless) is required for cv2.ximgproc")

TILE = 256
STRIDE = TILE * 3 // 4  # 192 -> 25% overlap, as in HoloDraw
DEFAULT_THRESHOLD = 0.3  # HOLOPAINT_DEFAULT_THRESHOLD in HoloDraw/config.py

_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)

# (N, 3, 256, 256) float32 -> (N, 256, 256) float32 in [0, 1]
Predictor = Callable[[np.ndarray], np.ndarray]


@dataclass
class Result:
    outline: np.ndarray  # (H, W) uint8, black edges on white
    probability: np.ndarray  # (H, W) float32 blended edge probability
    tiles: int  # model tiles run, excluding the global pass


def to_tensor(patch_bgr: np.ndarray) -> np.ndarray:
    """BGR uint8 patch -> ImageNet-normalised CHW float32."""
    rgb = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2RGB)
    tensor = rgb.transpose(2, 0, 1).astype(np.float32) / 255.0
    return (tensor - _MEAN) / _STD


def _predict(predict: Predictor, tensors: List[np.ndarray], batch_size: int) -> List[np.ndarray]:
    out: List[np.ndarray] = []
    for i in range(0, len(tensors), batch_size):
        out.extend(predict(np.stack(tensors[i:i + batch_size])))
    return out


def _predict_with_flip(predict: Predictor, patch_bgr: np.ndarray, batch_size: int) -> np.ndarray:
    """Test-time augmentation: average with the horizontally flipped prediction."""
    tensor = to_tensor(patch_bgr)
    pred, pred_flip = _predict(predict, [tensor, np.ascontiguousarray(tensor[:, :, ::-1])], batch_size)
    return (pred + np.flip(pred_flip, axis=1)) / 2.0


def edge_probability(image: np.ndarray, predict: Predictor, batch_size: int = 8) -> tuple:
    """Multi-scale inference: a global 256x256 pass (with TTA) blended with
    Hanning-weighted full-resolution tiles. Returns (probability, tile_count)."""
    h, w = image.shape[:2]

    if h <= TILE and w <= TILE:
        resized = cv2.resize(image, (TILE, TILE), interpolation=cv2.INTER_LINEAR)
        pred = _predict_with_flip(predict, resized, batch_size)
        return cv2.resize(pred, (w, h), interpolation=cv2.INTER_LINEAR), 0

    global_resized = cv2.resize(image, (TILE, TILE), interpolation=cv2.INTER_LINEAR)
    global_pred = _predict_with_flip(predict, global_resized, batch_size)
    global_full = cv2.resize(global_pred, (w, h), interpolation=cv2.INTER_LINEAR)

    pad_h = (STRIDE - (h % STRIDE)) % STRIDE
    pad_w = (STRIDE - (w % STRIDE)) % STRIDE
    padded = cv2.copyMakeBorder(image, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT_101)
    ph, pw = padded.shape[:2]

    window_1d = np.hanning(TILE).astype(np.float64)
    window_2d = np.clip(np.outer(window_1d, window_1d), 0.01, 1.0)

    origins = [(y, x) for y in range(0, ph - TILE + 1, STRIDE) for x in range(0, pw - TILE + 1, STRIDE)]
    tensors = [to_tensor(padded[y:y + TILE, x:x + TILE]) for y, x in origins]
    preds = _predict(predict, tensors, batch_size)

    acc = np.zeros((ph, pw), dtype=np.float64)
    weight_acc = np.zeros((ph, pw), dtype=np.float64)
    for (y, x), pred in zip(origins, preds):
        acc[y:y + TILE, x:x + TILE] += pred * window_2d
        weight_acc[y:y + TILE, x:x + TILE] += window_2d

    weight_acc = np.maximum(weight_acc, 1e-8)
    tile_full = (acc / weight_acc)[:h, :w].astype(np.float32)

    # Tiles dominate (fine detail); the global pass fills gaps.
    blended = np.maximum(tile_full * 0.7 + global_full * 0.3, np.maximum(tile_full, global_full * 0.5))
    return np.clip(blended, 0, 1).astype(np.float32), len(origins)


def bridge_endpoint_gaps(binary: np.ndarray, search_radius: int = 12) -> np.ndarray:
    """Join skeleton endpoints of *different* components that lie within
    `search_radius`, closing gaps that morphological closing misses."""
    skeleton = cv2.ximgproc.thinning(binary)

    skel_01 = (skeleton > 0).astype(np.float32)
    neighbor_kernel = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.float32)
    neighbor_count = cv2.filter2D(skel_01, -1, neighbor_kernel, borderType=cv2.BORDER_CONSTANT)

    # An endpoint is a skeleton pixel with exactly one skeleton neighbour.
    endpoint_mask = (skel_01 > 0) & (neighbor_count >= 0.5) & (neighbor_count < 1.5)
    ey, ex = np.where(endpoint_mask)
    if len(ey) < 2:
        return binary

    endpoints = list(zip(ex.tolist(), ey.tolist()))
    _, labels = cv2.connectedComponents(binary, connectivity=8)

    result = binary.copy()
    used = set()
    ep_arr = np.array(endpoints, dtype=np.float64)

    for i in range(len(endpoints)):
        if i in used:
            continue
        x1, y1 = endpoints[i]
        label1 = labels[y1, x1]

        diffs = ep_arr - ep_arr[i]
        dists = np.hypot(diffs[:, 0], diffs[:, 1])

        best_j = -1
        for j_idx in np.argsort(dists):
            j = int(j_idx)
            if j <= i or j in used:
                continue
            if dists[j] > search_radius:
                break
            x2, y2 = endpoints[j]
            if labels[y2, x2] == label1:
                continue
            best_j = j
            break

        if best_j >= 0:
            x2, y2 = endpoints[best_j]
            cv2.line(result, (x1, y1), (x2, y2), 255, 1, cv2.LINE_AA)
            used.add(i)
            used.add(best_j)

    return result


def outline_from_probability(image: np.ndarray, probability: np.ndarray, threshold: float) -> np.ndarray:
    """Canny fusion, hysteresis threshold, gap closing and noise removal."""
    h, w = image.shape[:2]

    # Canny catches thin edges the model misses; the model still dominates.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0.8)
    canny = cv2.Canny(blurred, int(30 + threshold * 70), int(80 + threshold * 120))
    fused = np.clip(probability + canny.astype(np.float32) / 255.0 * 0.3, 0, 1)

    # Hysteresis: keep weak pixels only where they touch strong ones.
    strong = (fused >= threshold).astype(np.uint8) * 255
    weak = (fused >= threshold * 0.35).astype(np.uint8) * 255
    connect_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    strong_dilated = cv2.dilate(strong, connect_kernel, iterations=1)
    binary = cv2.bitwise_or(strong, cv2.bitwise_and(weak, strong_dilated))

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel)
    binary = bridge_endpoint_gaps(binary, search_radius=14)

    # Drop small components. Vectorised version of HoloDraw's per-label loop;
    # same output, but O(pixels) instead of O(labels x pixels).
    _, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    min_area = max(25, int((w * h) * 0.0003))
    keep = stats[:, cv2.CC_STAT_AREA] >= min_area
    keep[0] = False  # background
    clean = np.where(keep[labels], 255, 0).astype(np.uint8)

    # Solidify lines so the fill bucket cannot leak through.
    dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    clean = cv2.dilate(clean, dilate_kernel, iterations=1)

    outline = 255 - clean
    cv2.rectangle(outline, (0, 0), (w - 1, h - 1), 0, 2)
    return outline


def colouring_page(
    image: np.ndarray,
    predict: Predictor,
    threshold: float = DEFAULT_THRESHOLD,
    batch_size: int = 8,
) -> Result:
    """BGR photo -> black-on-white outline with closed, fillable regions."""
    probability, tiles = edge_probability(image, predict, batch_size)
    return Result(outline_from_probability(image, probability, threshold), probability, tiles)
