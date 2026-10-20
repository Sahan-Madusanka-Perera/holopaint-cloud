import io

import cv2
import numpy as np
import pytest
from PIL import Image

from photo import InvalidPhoto, encode_png, load_photo


def encode(image: Image.Image, fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    image.save(buf, fmt, **kwargs)
    return buf.getvalue()


def test_accepts_jpeg_png_webp(shapes_jpeg):
    rgb = Image.open(io.BytesIO(shapes_jpeg))
    for fmt in ["JPEG", "PNG", "WEBP"]:
        assert load_photo(encode(rgb, fmt)).shape == (480, 640, 3)


def test_rejects_bytes_that_are_not_an_image():
    with pytest.raises(InvalidPhoto, match="not a supported image"):
        load_photo(b"%PDF-1.7 definitely not a photo")


def test_rejects_unsupported_format():
    with pytest.raises(InvalidPhoto, match="GIF"):
        load_photo(encode(Image.new("RGB", (64, 64)), "GIF"))


def test_rejects_oversized_file_before_decoding(shapes_jpeg):
    with pytest.raises(InvalidPhoto, match="bytes"):
        load_photo(shapes_jpeg, max_bytes=len(shapes_jpeg) - 1)


def test_rejects_too_many_pixels_from_header_alone():
    # 4000x4000 PNG of one colour is tiny on disk but 16 MP once decoded
    data = encode(Image.new("L", (4000, 4000)), "PNG")
    with pytest.raises(InvalidPhoto, match="too many pixels"):
        load_photo(data, max_pixels=10_000_000)


def test_rejects_tiny_images():
    with pytest.raises(InvalidPhoto, match="too small"):
        load_photo(encode(Image.new("RGB", (20, 400)), "PNG"))


def test_rejects_truncated_image(shapes_jpeg):
    with pytest.raises(InvalidPhoto):
        load_photo(shapes_jpeg[: len(shapes_jpeg) // 3])


def test_downscales_longer_side_only_when_needed():
    big = encode(Image.new("RGB", (3200, 1600), "white"), "PNG")
    assert load_photo(big).shape[:2] == (800, 1600)
    small = encode(Image.new("RGB", (800, 600), "white"), "PNG")
    assert load_photo(small).shape[:2] == (600, 800)


def test_applies_exif_orientation():
    # Phones store portrait photos as landscape pixels plus an EXIF rotation tag.
    landscape = Image.new("RGB", (200, 100), "white")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise to display
    upright = load_photo(encode(landscape, "JPEG", exif=exif))
    assert upright.shape[:2] == (200, 100)


def test_returns_bgr_channel_order():
    red = encode(Image.new("RGB", (64, 64), (255, 0, 0)), "PNG")
    assert tuple(load_photo(red)[0, 0]) == (0, 0, 255)


def test_encode_png_round_trips():
    outline = np.full((50, 80), 255, np.uint8)
    outline[10:20, 10:70] = 0
    decoded = cv2.imdecode(np.frombuffer(encode_png(outline), np.uint8), cv2.IMREAD_GRAYSCALE)
    assert np.array_equal(decoded, outline)
