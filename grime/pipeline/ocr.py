"""
OCR orchestration: engine dispatch, ditto resolution, and persistence.

Single source of truth for running OCR on a DocumentPage. Callers (viewer
endpoint, management command, etc.) should go through ``run_page`` or
``rerun_selection`` rather than reaching into ``pipeline.tesseract`` or
``pipeline.textract`` directly.

Engine selection:
    ``engine=None``        — Textract first, fall back to Tesseract on error
    ``engine='textract'``  — Textract only, surface errors
    ``engine='tesseract'`` — Tesseract only, surface errors

Word dicts are unified to the Textract shape:
    ``line_num, word_num, left, top, width, height, conf, text``
"""

import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

    from grime.models import DocumentPage, OCRPass

logger = logging.getLogger(__name__)

ENGINE_TEXTRACT = "textract"
ENGINE_TESSERACT = "tesseract"
_VALID_ENGINES = (ENGINE_TEXTRACT, ENGINE_TESSERACT)

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

    by_line: dict[int, list[dict]] = {}
    for w in words:
        by_line.setdefault(w["line_num"], []).append(w)

    line_keys = sorted(
        by_line, key=lambda k: sum(w["top"] for w in by_line[k]) / len(by_line[k])
    )

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


def dispatch(
    img: "PILImage", engine: Optional[str] = None
) -> tuple[str, float, list[dict], str]:
    """Run OCR on a PIL image and return (text, mean_conf, words, used_engine).

    Confidence is on a 0–100 scale (matches ``Word.conf``).  Words are
    post-processed by ``_resolve_dittos`` before return.

    With ``engine=None`` the default order is Textract → Tesseract.  Explicit
    engine names surface their errors instead of falling back.
    """
    if engine is not None and engine not in _VALID_ENGINES:
        raise ValueError(f"Unknown OCR engine: {engine!r}")

    if engine == ENGINE_TEXTRACT or engine is None:
        try:
            from grime.pipeline.textract import make_client, textract_page

            text, conf, words = textract_page(img, make_client())
            _resolve_dittos(words)
            return text, conf, words, ENGINE_TEXTRACT
        except Exception as exc:
            if engine == ENGINE_TEXTRACT:
                raise
            logger.warning("Textract unavailable (%s); falling back to Tesseract.", exc)

    from grime.pipeline.tesseract import ocr_image

    text, conf, words = ocr_image(img)
    _resolve_dittos(words)
    return text, conf, words, ENGINE_TESSERACT


def run_page(
    page: "DocumentPage", *, engine: Optional[str] = None, force: bool = False
) -> "Optional[OCRPass]":
    """Run OCR on ``page.image`` and persist results.

    Skip rules:
      - ``text_source`` ∈ {"embedded", "manual"} — those sources own their text.
      - No ``image`` on the page.

    On success, writes ``page.text``, creates an
    ``OCRPass``, and bulk-creates ``Word`` rows.  Returns the new ``OCRPass``
    (or ``None`` on skip).
    """
    from PIL import Image as PILImage

    from grime.models import OCRPass, Word

    if page.text_source in ("embedded", "manual"):
        return None
    img_field = getattr(page, "image", None)
    if not img_field:
        return None

    img = PILImage.open(img_field.path)
    text, conf, words, used_engine = dispatch(img, engine=engine)

    page.text = text.strip()
    page.save(update_fields=["text"])
    ocr_pass = OCRPass.objects.create(
        page=page,
        method=used_engine,
        confidence=conf,
        output_text=text.strip(),
        status=OCRPass.STATUS_COMPLETE,
    )
    Word.objects.bulk_create(
        [Word(page=page, ocr_pass=ocr_pass, **w) for w in words],
        ignore_conflicts=True,
    )
    return ocr_pass


def rerun_selection(
    page: "DocumentPage",
    word_pks: list[int],
    *,
    engine: Optional[str] = None,
) -> dict:
    """Re-OCR a Word selection (or the whole page) without creating an OCRPass.

    If ``word_pks`` is empty, every Word on the page is deleted and the full
    page is re-OCR'd.  Otherwise the union bbox of the selection (padded by
    4 px) is cropped, the selected Words are deleted, and the OCR output is
    inserted with bboxes translated back to the full page.

    ``line_num`` is inherited from the first deleted Word (0 for full-page);
    ``word_num`` is reassigned sequentially.  Page text / completion flags
    are not touched — this is a localised re-OCR, not a page-level pass.
    """
    from PIL import Image as PILImage

    from grime.models import Word

    if not page.image:
        raise ValueError("Page has no image to re-OCR")

    full_img = PILImage.open(page.image.path)

    if word_pks:
        words = list(Word.objects.filter(pk__in=word_pks, page_id=page.pk))
        if not words:
            raise ValueError("No words found on this page")
        padding = 4
        left = max(0, min(w.left for w in words) - padding)
        top = max(0, min(w.top for w in words) - padding)
        right = max(w.left + w.width for w in words) + padding
        bottom = max(w.top + w.height for w in words) + padding
        line_num = words[0].line_num
        deleted_ids = [w.pk for w in words]
        Word.objects.filter(pk__in=deleted_ids).delete()
    else:
        left, top, right, bottom = 0, 0, full_img.width, full_img.height
        line_num = 0
        deleted_ids = list(
            Word.objects.filter(page_id=page.pk).values_list("pk", flat=True)
        )
        Word.objects.filter(page_id=page.pk).delete()

    crop = full_img.crop(
        (left, top, min(right, full_img.width), min(bottom, full_img.height))
    )
    _, _, new_words, _ = dispatch(crop, engine=engine)

    created = []
    for i, row in enumerate(new_words):
        w = Word.objects.create(
            page=page,
            line_num=line_num,
            word_num=i,
            left=left + int(row["left"]),
            top=top + int(row["top"]),
            width=int(row["width"]),
            height=int(row["height"]),
            conf=float(row["conf"]),
            text=row["text"],
        )
        created.append(w)

    return {"deleted_ids": deleted_ids, "new_words": created}
