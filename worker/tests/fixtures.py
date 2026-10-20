"""Synthetic test images: no third-party photos are needed or committed."""

import cv2
import numpy as np


def shapes_image(width: int = 640, height: int = 480) -> np.ndarray:
    """Deterministic synthetic photo: gradient background plus filled shapes,
    so tests need no third-party images."""
    x = np.linspace(40, 200, width, dtype=np.float32)
    y = np.linspace(60, 160, height, dtype=np.float32)[:, None]
    image = np.dstack([np.broadcast_to(x, (height, width)), np.broadcast_to(y, (height, width)),
                       np.full((height, width), 120, np.float32)]).astype(np.uint8)
    cv2.circle(image, (180, 200), 90, (30, 60, 220), -1)
    cv2.rectangle(image, (330, 90), (560, 260), (40, 180, 60), -1)
    triangle = np.array([[300, 440], [470, 300], [600, 440]], np.int32)
    cv2.fillPoly(image, [triangle], (210, 160, 30))
    cv2.line(image, (40, 400), (260, 330), (0, 0, 0), 6)
    return image
