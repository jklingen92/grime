import io

import cv2
import numpy as np
import pytesseract
import requests
from PIL import Image, ImageEnhance

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
    img = img.convert("L")

    if img.width < 2000:
        scale = 2000 / img.width
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)

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
    resp = requests.get(url, headers=_HEADERS, proxies=proxies, timeout=30)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


# Documents scoring below this threshold are flagged for manual review
CONFIDENCE_THRESHOLD = 60.0

# Proportion of midtone pixels (50–200 after normalization) above which an
# image is classified as visual content rather than pure text.
VISUAL_CONTENT_THRESHOLD = 0.15

# Character-height coefficient of variation above which an image is classified
# as handwritten. Typed text is ~0.15–0.30; handwriting is ~0.40–0.70+.
HANDWRITING_THRESHOLD = 0.45


def is_visual_content(img: Image.Image, threshold: float = VISUAL_CONTENT_THRESHOLD) -> bool:
    """
    Return True if the image appears to contain a photo or illustration.

    Text clips are near-bimodal (black ink on white paper) even when dark or
    low-contrast. Photos and halftone engravings have significant midtone
    content. To handle dark or low-contrast originals, pixel values are
    percentile-stretched to the 2nd–98th percentile before the midtone ratio
    is measured.
    """
    gray = np.array(img.convert("L"), dtype=np.float32)
    lo, hi = np.percentile(gray, 2), np.percentile(gray, 98)
    if hi > lo:
        gray = np.clip((gray - lo) / (hi - lo) * 255, 0, 255)
    midtone_ratio = np.mean((gray > 50) & (gray < 200))
    return float(midtone_ratio) > threshold


def handwriting_score(img: Image.Image) -> float:
    """
    Return a score in [0.0, 1.0] estimating how likely the image is handwritten.

    Combines two signals, each derived from character-scale connected components
    (form borders, page-spanning rules, and large headings are filtered out by
    area bounds so only fill-in text remains):

      1. Height CV — typed characters are very uniform in height; handwritten
         characters vary even when neat (CV ~0.15–0.30 typed, ~0.40–0.70+ written).

      2. Baseline irregularity — even neat handwriting has slight waviness in
         where characters sit on the line; typewriter/print text is mechanically
         level. Measured as the mean within-line std of bottom edges, normalised
         by median character height.

    The two scores are blended (35 % height, 65 % baseline) so that neat
    handwriting that passes height CV alone is caught by baseline drift.

    The normalisation constants are approximate — use --dry-run on a labelled
    sample and adjust HANDWRITING_THRESHOLD (or the constants below) to taste.

    Returns 0.0 for clearly typed, 1.0 for clearly handwritten.
    Compare against HANDWRITING_THRESHOLD to get a boolean classification.
    """
    gray = np.array(img.convert("L"))

    if gray.shape[1] < 1000:
        scale = 1000 / gray.shape[1]
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)

    h, w = gray.shape
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    num_labels, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)

    # Keep only character-scale components. Form borders, decorative rules, and
    # large headings are too tall/wide; noise and punctuation dots are too small.
    min_h, max_h = h * 0.01, h * 0.08
    min_w, max_w = w * 0.005, w * 0.06

    char_idx = [
        i
        for i in range(1, num_labels)
        if min_h <= stats[i, cv2.CC_STAT_HEIGHT] <= max_h
        and min_w <= stats[i, cv2.CC_STAT_WIDTH] <= max_w
    ]

    if len(char_idx) < 20:
        return 0.5  # not enough character-scale components to classify

    heights = np.array([float(stats[i, cv2.CC_STAT_HEIGHT]) for i in char_idx])
    tops = np.array([float(stats[i, cv2.CC_STAT_TOP]) for i in char_idx])
    bottoms = tops + heights

    # --- Signal 1: height coefficient of variation ---
    mean_h = float(heights.mean())
    height_cv = float(heights.std() / mean_h) if mean_h > 0 else 0.0
    height_score = float(np.clip((height_cv - 0.15) / 0.50, 0.0, 1.0))

    # --- Signal 2: baseline irregularity ---
    # Group components into text lines by clustering on vertical centre.
    # For each line, measure how much the bottom edges deviate from the line
    # median (normalised by median character height). Typed text is mechanically
    # level (normalised std ≈ 0.02–0.08); even neat handwriting drifts more
    # (≈ 0.10–0.30+).
    centers_y = tops + heights / 2
    order = np.argsort(centers_y)
    sorted_centers = centers_y[order]
    sorted_bottoms = bottoms[order]

    median_h = float(np.median(heights))
    gaps = np.diff(sorted_centers)
    breaks = np.where(gaps > median_h * 0.7)[0]
    line_starts = np.concatenate([[0], breaks + 1])
    line_ends = np.concatenate([breaks + 1, [len(sorted_centers)]])

    baseline_devs = []
    for s, e in zip(line_starts, line_ends):
        if e - s < 4:
            continue
        dev = float(np.std(sorted_bottoms[s:e]) / median_h)
        baseline_devs.append(dev)

    if baseline_devs:
        # Typed: mean_dev ≈ 0.02–0.08. Neat handwriting: ≈ 0.10–0.30+.
        baseline_score = float(np.clip(np.mean(baseline_devs) / 0.25, 0.0, 1.0))
    else:
        baseline_score = height_score

    return 0.35 * height_score + 0.65 * baseline_score


_DITTO_MARK = '"'


def _resolve_dittos(words: list[dict]) -> list[dict]:
    """
    Replace ditto-mark words with the text projected from above at their horizontal position.

    Maintains a shadow list — a sorted sequence of (left, right, text) segments representing
    the most recent word seen at each horizontal position across all lines processed so far.
    Lines are processed top-to-bottom; within each line words are processed left-to-right.

    When a ditto is encountered its text is set to whichever shadow segment has the greatest
    horizontal overlap with it. The ditto's resolved text (or any normal word's text) then
    overwrites that portion of the shadow, so chained dittos propagate correctly.
    """
    if not words:
        return words

    by_line: dict[tuple, list[dict]] = {}
    for w in words:
        key = (w["block_num"], w["par_num"], w["line_num"])
        by_line.setdefault(key, []).append(w)

    line_keys = sorted(by_line, key=lambda k: sum(w["top"] for w in by_line[k]) / len(by_line[k]))

    # shadow: sorted list of (left, right, text) with no gaps; starts empty
    shadow: list[tuple[int, int, str]] = []

    def _query(d_left: int, d_right: int) -> str | None:
        best_text, best_overlap = None, 0
        for seg_left, seg_right, seg_text in shadow:
            overlap = min(d_right, seg_right) - max(d_left, seg_left)
            if overlap > best_overlap:
                best_overlap, best_text = overlap, seg_text
        return best_text

    def _update(w_left: int, w_right: int, text: str) -> None:
        nonlocal shadow
        trimmed = []
        for seg_left, seg_right, seg_text in shadow:
            if seg_right <= w_left or seg_left >= w_right:
                trimmed.append((seg_left, seg_right, seg_text))
            else:
                if seg_left < w_left:
                    trimmed.append((seg_left, w_left, seg_text))
                if seg_right > w_right:
                    trimmed.append((w_right, seg_right, seg_text))
        trimmed.append((w_left, w_right, text))
        trimmed.sort(key=lambda s: s[0])
        shadow = trimmed

    for key in line_keys:
        for w in sorted(by_line[key], key=lambda w: w["left"]):
            w_left, w_right = w["left"], w["left"] + w["width"]
            if w["text"].strip() == _DITTO_MARK:
                resolved = _query(w_left, w_right)
                if resolved is not None:
                    w["text"] = resolved
                    w["is_ditto"] = True
            _update(w_left, w_right, w["text"])

    return words


def ocr_image(img: Image.Image, config: str = TESS_CONFIG) -> tuple[str, float, list[dict]]:
    """
    Preprocess and run Tesseract on a PIL Image.

    Returns (text, mean_confidence, words) where:
    - text is the full OCR output string
    - mean_confidence is 0–100 (documents below CONFIDENCE_THRESHOLD should be flagged)
    - words is a list of per-word dicts with keys: block_num, par_num, line_num,
      word_num, left, top, width, height, conf, text
    """
    processed = preprocess(img)
    data = pytesseract.image_to_data(processed, config=config, output_type=pytesseract.Output.DICT)
    confidences = [c for c in data["conf"] if c != -1]
    mean_conf = round(sum(confidences) / len(confidences), 1) if confidences else 0.0
    words = [
        {
            k: data[k][i]
            for k in (
                "block_num",
                "par_num",
                "line_num",
                "word_num",
                "left",
                "top",
                "width",
                "height",
                "conf",
                "text",
            )
        }
        for i in range(len(data["text"]))
        if data["conf"][i] != -1 and data["text"][i].strip()
    ]
    text = pytesseract.image_to_string(processed, config=config)
    return text, mean_conf, words
