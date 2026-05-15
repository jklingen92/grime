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
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractBaseUser
    from PIL.Image import Image as PILImage

    from grime.models import DocumentPage, OCRPass

logger = logging.getLogger(__name__)

ENGINE_TEXTRACT = "textract"
ENGINE_TESSERACT = "tesseract"
_VALID_ENGINES = (ENGINE_TEXTRACT, ENGINE_TESSERACT)


def post_ocr(
    page: "DocumentPage", *, user: "Optional[AbstractBaseUser]" = None
) -> list[dict]:
    """Run post-OCR cleanup on ``page`` after any OCR change.

    Currently resolves dittos against the page's Words.  Call this from
    every code path that creates, deletes, or edits Words.  Returns the
    list of ``{"id", "corrected_text", "is_ditto"}`` rows whose effective
    text changed during cleanup so callers can echo the diff back to the
    UI without a full reload.
    """
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
            text=row["text"],
        )
        created.append(w)

    post_ocr(page)
    return {"deleted_ids": deleted_ids, "new_words": created}
