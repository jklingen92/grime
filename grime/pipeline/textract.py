import io
from collections import defaultdict

from PIL import Image


def make_client(region: str = "us-east-1"):
    """Return a boto3 Textract client using the standard credential chain."""
    import boto3

    return boto3.client("textract", region_name=region)


def _detect_line_centers(words: list[dict], img_h: int) -> list[int]:
    """
    Return sorted y-coordinates of text line centers.

    Builds a density profile where density[y] = number of word bounding boxes
    that overlap pixel row y, then returns local maxima.  Nearby maxima closer
    than half the median word height are merged, keeping the highest-density
    representative.
    """
    if not words:
        return []

    density = [0] * img_h
    for w in words:
        for y in range(max(0, w["top"]), min(img_h, w["top"] + w["height"])):
            density[y] += 1

    heights = sorted(w["height"] for w in words)
    min_sep = max(2, heights[len(heights) // 2] // 2)

    # Raw local maxima: strictly greater than one neighbour, non-zero
    candidates = [
        y
        for y in range(1, img_h - 1)
        if density[y] > 0
        and density[y] >= density[y - 1]
        and density[y] >= density[y + 1]
        and (density[y] > density[y - 1] or density[y] > density[y + 1])
    ]

    if not candidates:
        return []

    # Merge candidates within min_sep; keep the peak with highest density
    lines = []
    group = [candidates[0]]
    for c in candidates[1:]:
        if c - group[-1] <= min_sep:
            group.append(c)
        else:
            lines.append(max(group, key=lambda y: density[y]))
            group = [c]
    lines.append(max(group, key=lambda y: density[y]))

    return lines


def textract_page(img: Image.Image, client) -> tuple[str, float, list[dict]]:
    """
    Run AWS Textract DetectDocumentText on a PIL Image.

    Returns (text, mean_confidence, words) in the same format as ocr_image():
    - text: page text with line breaks
    - mean_confidence: 0–100 (Textract native scale)
    - words: list of per-word dicts with keys line_num, word_num,
      left, top, width, height, conf, text;
      bboxes are scaled to pixel coords using the image dimensions

    Line assignments are derived from the word-density profile rather than
    Textract LINE blocks, since LINE-block granularity is insufficient.
    """
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    resp = client.detect_document_text(Document={"Bytes": buf.getvalue()})

    blocks = resp.get("Blocks", [])
    img_w, img_h = img.size

    word_blocks = [b for b in blocks if b["BlockType"] == "WORD"]

    mean_conf = (
        sum(b["Confidence"] for b in word_blocks) / len(word_blocks)
        if word_blocks
        else 0.0
    )

    # Convert all words to pixel-space dicts (no line assignment yet)
    raw_words = []
    for wb in word_blocks:
        bb = wb["Geometry"]["BoundingBox"]
        raw_words.append(
            {
                "left": round(bb["Left"] * img_w),
                "top": round(bb["Top"] * img_h),
                "width": max(1, round(bb["Width"] * img_w)),
                "height": max(1, round(bb["Height"] * img_h)),
                "conf": round(wb["Confidence"], 2),
                "text": wb["Text"],
            }
        )

    line_centers = _detect_line_centers(raw_words, img_h)

    def nearest_line_index(w: dict) -> int:
        center_y = w["top"] + w["height"] / 2
        return min(range(len(line_centers)), key=lambda i: abs(line_centers[i] - center_y))

    # Group words by line index, then sort lines top-to-bottom and words left-to-right
    line_groups: dict[int, list[dict]] = defaultdict(list)
    for w in raw_words:
        li = nearest_line_index(w) if line_centers else 0
        line_groups[li].append(w)

    words = []
    line_text_parts = []
    for line_num, (_li, line_words) in enumerate(
        sorted(line_groups.items(), key=lambda kv: line_centers[kv[0]] if line_centers else 0)
    ):
        line_words.sort(key=lambda w: w["left"])
        line_text_parts.append(" ".join(w["text"] for w in line_words))
        for word_num, w in enumerate(line_words):
            words.append({**w, "line_num": line_num, "word_num": word_num})

    text = "\n".join(line_text_parts)
    return text, mean_conf, words
