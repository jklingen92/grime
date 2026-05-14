import io

from PIL import Image


def make_client(region: str = "us-east-1"):
    """Return a boto3 Textract client using the standard credential chain."""
    import boto3

    return boto3.client("textract", region_name=region)


def textract_page(img: Image.Image, client) -> tuple[str, float, list[dict]]:
    """
    Run AWS Textract DetectDocumentText on a PIL Image.

    Returns (text, mean_confidence, words) in the same format as ocr_image():
    - text: page text with line breaks
    - mean_confidence: 0–100 (Textract native scale)
    - words: list of per-word dicts with keys block_num, par_num, line_num,
      word_num, left, top, width, height, conf, text;
      bboxes are scaled to pixel coords using the image dimensions
    """
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    resp = client.detect_document_text(Document={"Bytes": buf.getvalue()})

    blocks = resp.get("Blocks", [])
    img_w, img_h = img.size

    # Index by BlockType
    lines = [b for b in blocks if b["BlockType"] == "LINE"]
    word_blocks = [b for b in blocks if b["BlockType"] == "WORD"]
    word_by_id = {b["Id"]: b for b in word_blocks}

    text = "\n".join(b["Text"] for b in lines)
    mean_conf = sum(b["Confidence"] for b in word_blocks) / len(word_blocks) if word_blocks else 0.0

    words = []
    for line_i, line in enumerate(lines):
        child_ids = []
        for rel in line.get("Relationships", []):
            if rel["Type"] == "CHILD":
                child_ids.extend(rel["Ids"])
        for word_j, wid in enumerate(child_ids):
            wb = word_by_id.get(wid)
            if wb is None:
                continue
            bb = wb["Geometry"]["BoundingBox"]
            words.append(
                {
                    "block_num": 0,
                    "par_num": 0,
                    "line_num": line_i,
                    "word_num": word_j,
                    "left": round(bb["Left"] * img_w),
                    "top": round(bb["Top"] * img_h),
                    "width": max(1, round(bb["Width"] * img_w)),
                    "height": max(1, round(bb["Height"] * img_h)),
                    "conf": round(wb["Confidence"], 2),
                    "text": wb["Text"],
                }
            )

    return text, mean_conf, words
