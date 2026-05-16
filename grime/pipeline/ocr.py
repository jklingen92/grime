"""
OCR orchestration: engine dispatch and persistence.

Single source of truth for running OCR on a DocumentPage. Callers (viewer
endpoint, management command, etc.) should go through ``run_page`` or
``rerun_selection`` rather than reaching into ``pipeline.tesseract`` or
``pipeline.textract`` directly.

Any code path that adds, removes, or changes the OCR for a page should
call :func:`post_ocr` once the DB writes are done.  Ditto resolution
(and any future post-OCR cleanup) lives in there.

Engine selection:
    ``engine=None``        — Textract first, fall back to Tesseract on error
    ``engine='textract'``  — Textract only, surface errors
    ``engine='tesseract'`` — Tesseract only, surface errors

Word dicts are unified to the Textract shape:
    ``line_num, word_num, left, top, width, height, conf, text``
"""

import logging
from collections import defaultdict
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractBaseUser
    from PIL.Image import Image as PILImage

    from grime.models import DocumentPage, OCRPass

logger = logging.getLogger(__name__)

ENGINE_TEXTRACT = "textract"
ENGINE_TESSERACT = "tesseract"
_VALID_ENGINES = (ENGINE_TEXTRACT, ENGINE_TESSERACT)


def _detect_line_centers(words: list[dict], img_h: int) -> list[int]:
    """
    Return sorted y-coordinates of text line centers.

    Builds a density profile (density[y] = word bboxes overlapping row y),
    smooths it with a box filter to eliminate within-line bumps caused by
    words on the same row having slightly different top values, then returns
    local maxima of the smoothed profile.  Residual nearby maxima closer than
    half the median word height are merged, keeping the highest-density one.
    """
    if not words:
        return []

    density = [0] * img_h
    for w in words:
        for y in range(max(0, w["top"]), min(img_h, w["top"] + w["height"])):
            density[y] += 1

    heights = sorted(w["height"] for w in words)
    word_h = max(1, heights[len(heights) // 2])

    # Box-filter half-width: large enough to smooth within-line top variation
    # (~30% of word height) while preserving inter-line valleys.
    half_w = max(1, word_h // 4)
    prefix = [0] * (img_h + 1)
    for y in range(img_h):
        prefix[y + 1] = prefix[y] + density[y]

    smoothed = []
    for y in range(img_h):
        lo = max(0, y - half_w)
        hi = min(img_h, y + half_w + 1)
        smoothed.append((prefix[hi] - prefix[lo]) / (hi - lo))

    # Local maxima of smoothed profile
    candidates = [
        y
        for y in range(1, img_h - 1)
        if smoothed[y] > 0
        and smoothed[y] >= smoothed[y - 1]
        and smoothed[y] >= smoothed[y + 1]
        and (smoothed[y] > smoothed[y - 1] or smoothed[y] > smoothed[y + 1])
    ]

    if not candidates:
        return []

    # Merge residual nearby maxima within half a word height
    min_sep = max(2, word_h // 2)
    lines = []
    group = [candidates[0]]
    for c in candidates[1:]:
        if c - group[-1] <= min_sep:
            group.append(c)
        else:
            lines.append(max(group, key=lambda y: smoothed[y]))
            group = [c]
    lines.append(max(group, key=lambda y: smoothed[y]))

    return lines


def _reassign_line_nums(page: "DocumentPage") -> None:
    """Reassign line_num and word_num for all Words on ``page``.

    Uses a word-density profile to detect line centers, then assigns each
    word to its nearest center.  Words are sorted left-to-right within each
    line.  Done in two bulk-update passes to avoid unique-constraint
    collisions during reassignment.
    """
    from grime.models import Word

    word_rows = list(
        Word.objects.filter(page=page).values("pk", "left", "top", "width", "height")
    )
    if not word_rows:
        return

    img_h = max(w["top"] + w["height"] for w in word_rows) + 1
    line_centers = _detect_line_centers(word_rows, img_h)

    def nearest(w: dict) -> int:
        cy = w["top"] + w["height"] / 2
        return min(range(len(line_centers)), key=lambda i: abs(line_centers[i] - cy))

    line_groups: dict[int, list[dict]] = defaultdict(list)
    for w in word_rows:
        line_groups[nearest(w) if line_centers else 0].append(w)

    final: list[Word] = []
    for line_num, (_li, lw) in enumerate(
        sorted(line_groups.items(), key=lambda kv: line_centers[kv[0]] if line_centers else 0)
    ):
        lw.sort(key=lambda w: w["left"])
        for word_num, w in enumerate(lw):
            final.append(Word(pk=w["pk"], line_num=line_num, word_num=word_num))

    n = len(final)
    # Pass 1: shift every row to a temporary range (n+i) that cannot collide
    # with final values (max final line_num < n by construction).
    temp = [Word(pk=f.pk, line_num=n + i, word_num=0) for i, f in enumerate(final)]
    Word.objects.bulk_update(temp, ["line_num", "word_num"])
    # Pass 2: write final values.
    Word.objects.bulk_update(final, ["line_num", "word_num"])


def post_ocr(
    page: "DocumentPage", *, user: "Optional[AbstractBaseUser]" = None
) -> list[dict]:
    """Run post-OCR cleanup on ``page`` after any OCR change.

    Reassigns line/word numbers via density-based line detection, then
    resolves ditto marks.  Call this from every code path that creates,
    deletes, or edits Words.  Returns the list of
    ``{"id", "corrected_text", "is_ditto"}`` rows whose effective text
    changed during ditto resolution.
    """
    _reassign_line_nums(page)

    from grime.pipeline.ditto import resolve_page

    return resolve_page(page, user=user)


def dispatch(
    img: "PILImage", engine: Optional[str] = None
) -> tuple[str, float, list[dict], str]:
    """Run OCR on a PIL image and return (text, mean_conf, words, used_engine).

    Confidence is on a 0–100 scale (matches ``Word.conf``).  Raw OCR text
    is returned untouched — ditto marks come back as ``"`` and are
    resolved later by :func:`post_ocr` once the words have been saved.

    With ``engine=None`` the default order is Textract → Tesseract.  Explicit
    engine names surface their errors instead of falling back.
    """
    if engine is not None and engine not in _VALID_ENGINES:
        raise ValueError(f"Unknown OCR engine: {engine!r}")

    if engine == ENGINE_TEXTRACT or engine is None:
        try:
            from grime.pipeline.textract import make_client, textract_page

            text, conf, words = textract_page(img, make_client())
            return text, conf, words, ENGINE_TEXTRACT
        except Exception as exc:
            if engine == ENGINE_TEXTRACT:
                raise
            logger.warning("Textract unavailable (%s); falling back to Tesseract.", exc)

    from grime.pipeline.tesseract import ocr_image

    text, conf, words = ocr_image(img)
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
    post_ocr(page)
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
            ocr_text=row["text"],
        )
        created.append(w)

    post_ocr(page)
    return {"deleted_ids": deleted_ids, "new_words": created}
