"""Ditto-mark resolution.

A "ditto" is a word whose OCR text is a lone quotation mark, meaning
"same as the word above".  The resolver walks every word on a page
top-to-bottom, left-to-right, maintaining a shadow of (left, right, text)
segments that record the most recent word seen at each horizontal
position.  When a ditto is encountered its text is replaced with the
shadow segment that overlaps it the most; the resolved text then
overwrites that slice of the shadow so chained dittos propagate.

Word boundaries are the only structure used — line_num / word_num and
any other OCR grouping are ignored.
"""

from typing import TYPE_CHECKING, Optional

from django.utils import timezone

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractBaseUser

    from grime.models import DocumentPage

DITTO_MARK = '"'


def is_ditto_mark(text: str | None) -> bool:
    return (text or "").strip() == DITTO_MARK


def resolve(words: list[dict]) -> list[dict]:
    """Resolve dittos in place against a list of word dicts.

    Each dict needs ``left``, ``top``, ``width``, ``text``.  Words whose
    text is the ditto mark get their ``text`` replaced with the projected
    shadow value and ``is_ditto`` set to True; a ditto with no shadow
    above it is left untouched.  Returns the same list.
    """
    if not words:
        return words

    shadow: list[tuple[int, int, str]] = []

    for w in sorted(words, key=lambda w: (w["top"], w["left"])):
        w_left = w["left"]
        w_right = w_left + w["width"]

        if is_ditto_mark(w.get("text")):
            best_text, best_overlap = None, 0
            for seg_left, seg_right, seg_text in shadow:
                overlap = min(w_right, seg_right) - max(w_left, seg_left)
                if overlap > best_overlap:
                    best_overlap, best_text = overlap, seg_text
            if best_text is not None:
                w["text"] = best_text
                w["is_ditto"] = True

        trimmed: list[tuple[int, int, str]] = []
        for seg_left, seg_right, seg_text in shadow:
            if seg_right <= w_left or seg_left >= w_right:
                trimmed.append((seg_left, seg_right, seg_text))
            else:
                if seg_left < w_left:
                    trimmed.append((seg_left, w_left, seg_text))
                if seg_right > w_right:
                    trimmed.append((w_right, seg_right, seg_text))
        trimmed.append((w_left, w_right, w["text"]))
        trimmed.sort(key=lambda s: s[0])
        shadow = trimmed

    return words


def resolve_page(
    page: "DocumentPage", *, user: "Optional[AbstractBaseUser]" = None
) -> list[dict]:
    """Resolve dittos across every Word on ``page`` and persist changes.

    Walks each Word's text (``corrected_text`` if set, else
    ``ocr_text``).  For Words whose raw OCR text is a ditto mark, or
    that were previously resolved as dittos (``is_ditto=True``), the
    resolved value is written to ``corrected_text`` with ``is_ditto=True``
    and the supplied ``user`` recorded as the corrector.  Words whose raw
    text is not a ditto mark and are not already marked as dittos are not
    touched — human corrections on non-ditto words are preserved.

    Returns one ``{"id", "corrected_text", "is_ditto"}`` row per Word
    whose effective text changed.
    """
    from grime.models import Word

    words = list(Word.objects.filter(page=page))
    if not words:
        return []

    rows: list[dict] = []
    by_pk: dict[int, "Word"] = {}
    for w in words:
        by_pk[w.pk] = w
        should_resolve = is_ditto_mark(w.ocr_text) or w.is_ditto
        rows.append(
            {
                "id": w.pk,
                "left": w.left,
                "top": w.top,
                "width": w.width,
                "text": DITTO_MARK if should_resolve else w.text,
                "_raw_is_ditto": should_resolve,
                "_effective_before": w.text,
            }
        )

    resolve(rows)

    changed: list[dict] = []
    now = timezone.now()
    for row in rows:
        if not row["_raw_is_ditto"]:
            continue
        w = by_pk[row["id"]]
        new_text = row["text"]
        if new_text != row["_effective_before"]:
            Word.objects.filter(pk=w.pk).update(
                corrected_text=new_text,
                corrected_ocr_by=user,
                corrected_ocr_at=now,
                is_ditto=True,
            )
            changed.append(
                {"id": w.pk, "corrected_text": new_text, "is_ditto": True}
            )
        elif not w.is_ditto and new_text != w.text:
            Word.objects.filter(pk=w.pk).update(is_ditto=True)
    return changed
