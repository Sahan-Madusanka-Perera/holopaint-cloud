"""
Decode and sanitise an uploaded photo before it reaches the pipeline.

Uploads come from the public internet, so everything here assumes hostile input:
the byte size and pixel count are checked *before* decoding (decompression bombs),
only real JPEG/PNG/WebP files are accepted whatever the extension or Content-Type
says, and EXIF is applied (phone photos are stored sideways) and then discarded.
"""

import io

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 5 * 1024 * 1024  # presigned POST enforces this too; defence in depth
MAX_PIXELS = 40_000_000  # checked from the header, before any pixels are decoded
MAX_SIDE = 1600  # longer side after resizing; bounds inference time and cost
MIN_SIDE = 32
FORMATS = {"JPEG", "PNG", "WEBP"}


class InvalidPhoto(ValueError):
    """The upload can never be processed; retrying won't help."""


def load_photo(
    data: bytes,
    max_bytes: int = MAX_BYTES,
    max_pixels: int = MAX_PIXELS,
    max_side: int = MAX_SIDE,
) -> np.ndarray:
    """Bytes -> upright BGR uint8 image whose longer side is at most `max_side`."""
    if len(data) > max_bytes:
        raise InvalidPhoto(f"file is {len(data)} bytes; the limit is {max_bytes}")

    try:
        image = Image.open(io.BytesIO(data))  # lazy: reads the header only
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidPhoto("not a supported image") from exc

    if image.format not in FORMATS:
        raise InvalidPhoto(f"format {image.format} is not supported; use JPEG, PNG or WebP")
    width, height = image.size
    if width * height > max_pixels:
        raise InvalidPhoto(f"{width}x{height} is too many pixels; the limit is {max_pixels}")
    if min(width, height) < MIN_SIDE:
        raise InvalidPhoto(f"{width}x{height} is too small; each side needs {MIN_SIDE}px")

    try:
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise InvalidPhoto("image data is corrupt") from exc

    bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    h, w = bgr.shape[:2]
    scale = max_side / max(h, w)
    if scale < 1:
        bgr = cv2.resize(bgr, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    return bgr


def encode_png(outline: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", outline)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()
