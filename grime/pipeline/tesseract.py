"""
Tesseract OCR helpers.

Top-of-module imports are kept lightweight (stdlib + Pillow); functions that
need OpenCV, numpy, pytesseract or requests import them lazily.
"""

import io

from PIL import Image

TESS_CONFIG = "--oem 3 --psm 3"

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
}


def preprocess(img: Image.Image) -> Image.Image:
    """
    Prepare a scanned document image for Tesseract.

    Pipeline:
      1. Grayscale
      2. Upscale to at least 2000px wide (Tesseract accuracy improves above ~300 DPI)
      3. Contrast boost
      4. Deskew via minAreaRect on dark pixels
      5. Denoise
      6. Binarize with Otsu thresholding
    """
    import cv2
    import numpy as np
    from PIL import ImageEnhance

    img = img.convert("L")

    if img.width < 2000:
        scale = 2000 / img.width
        img = img.resize(
            (int(img.width * scale), int(img.height * scale)), Image.LANCZOS
        )

    img = ImageEnhance.Contrast(img).enhance(2.0)

    arr = np.array(img)

    inverted = cv2.bitwise_not(arr)
    coords = np.column_stack(np.where(inverted > 0))
    if len(coords) >= 5:
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle
        if abs(angle) > 0.5:
            h, w = arr.shape
            M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
            arr = cv2.warpAffine(
                arr, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
            )

    arr = cv2.fastNlMeansDenoising(arr, h=15)
    _, arr = cv2.threshold(arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return Image.fromarray(arr)


def fetch_image(url: str, proxies: dict | None = None) -> Image.Image:
    """Download an image from a URL and return it as a PIL Image."""
    import requests

    resp = requests.get(url, headers=_HEADERS, proxies=proxies, timeout=30)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


# Documents scoring below this threshold are flagged for manual review
CONFIDENCE_THRESHOLD = 60.0

# Proportion of midtone pixels (50–200 after normalization) above which an
# image is classified as visual content rather than pure text.
VISUAL_CONTENT_THRESHOLD = 0.15


def is_visual_content(
    img: Image.Image, threshold: float = VISUAL_CONTENT_THRESHOLD
) -> bool:
    """
    Return True if the image appears to contain a photo or illustration.

    Text clips are near-bimodal (black ink on white paper) even when dark or
    low-contrast. Photos and halftone engravings have significant midtone
    content. To handle dark or low-contrast originals, pixel values are
    percentile-stretched to the 2nd–98th percentile before the midtone ratio
    is measured.
    """
    import numpy as np

    gray = np.array(img.convert("L"), dtype=np.float32)
    lo, hi = np.percentile(gray, 2), np.percentile(gray, 98)
    if hi > lo:
        gray = np.clip((gray - lo) / (hi - lo) * 255, 0, 255)
    midtone_ratio = np.mean((gray > 50) & (gray < 200))
    return float(midtone_ratio) > threshold


def ocr_image(
    img: Image.Image, config: str = TESS_CONFIG
) -> tuple[str, float, list[dict]]:
    """
    Preprocess and run Tesseract on a PIL Image.

    Returns (text, mean_confidence, words) where:
    - text is the full OCR output string
    - mean_confidence is 0–100 (documents below CONFIDENCE_THRESHOLD should be flagged)
    - words is a list of per-word dicts with keys: line_num, word_num,
      left, top, width, height, conf, text.

    Tesseract's native output is hierarchical (block, paragraph, line, word).
    We flatten it to the Textract shape: groups of (block, par, line) are
    sorted top-to-bottom and assigned a single global line_num; word_num
    is reassigned left-to-right within each line.
    """
    import pytesseract

    processed = preprocess(img)
    data = pytesseract.image_to_data(
        processed, config=config, output_type=pytesseract.Output.DICT
    )
    confidences = [c for c in data["conf"] if c != -1]
    mean_conf = round(sum(confidences) / len(confidences), 1) if confidences else 0.0

    raw_by_group: dict[tuple, list[dict]] = {}
    for i in range(len(data["text"])):
        if data["conf"][i] == -1 or not data["text"][i].strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        raw_by_group.setdefault(key, []).append(
            {
                "left": data["left"][i],
                "top": data["top"][i],
                "width": data["width"][i],
                "height": data["height"][i],
                "conf": data["conf"][i],
                "text": data["text"][i],
            }
        )

    sorted_keys = sorted(
        raw_by_group,
        key=lambda k: sum(w["top"] for w in raw_by_group[k]) / len(raw_by_group[k]),
    )
    words = []
    for new_line, k in enumerate(sorted_keys):
        line_words = sorted(raw_by_group[k], key=lambda w: w["left"])
        for new_wn, w in enumerate(line_words):
            w["line_num"] = new_line
            w["word_num"] = new_wn
            words.append(w)

    text = pytesseract.image_to_string(processed, config=config)
    return text, mean_conf, words
