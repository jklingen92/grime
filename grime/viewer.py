"""
Views and template-context wiring for the embedded document viewer.

The viewer lives on the DocumentPage admin change form and exchanges JSON
with the browser via a small set of AJAX endpoints, all rooted under
``/admin/grime/documentpage/<page_pk>/viewer/``.  Endpoint URLs are
attached to ``DocumentPageAdmin.get_urls()`` so they share the admin's
auth and CSRF treatment.

Endpoints implemented here:

    POST words/correct/       — set Word.corrected_text
    POST words/add/           — create a new Word at a drawn bbox
    POST words/delete/        — delete a Word
    POST words/ner-correct/   — set Word.corrected_label
    POST words/mark-ditto/    — mark one Word as a ditto and re-resolve the page
    POST words/bulk-delete/   — delete multiple Words at once
    POST words/bulk-ditto/    — mark multiple Words as dittos and re-resolve the page
    POST words/rerun-ocr/     — re-OCR the union bbox of a Word selection
    POST tags/create/         — create a Tag on this page
    POST tags/update/         — edit an existing Tag
    POST tags/delete/         — delete a Tag

Word ops are scoped to the page in the URL — the view rejects requests
that try to touch a Word belonging to a different page.
"""

import json
import os
import tempfile
from pathlib import Path

from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.contenttypes.models import ContentType
from django.db.models import Count, Max
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import path, reverse
from django.utils import timezone
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_POST

from grime.forms import DocumentUploadForm
from grime.models import Document, DocumentPage, Tag, Word

_VALID_NER_LABELS = {None, "B-PER", "I-PER", "B-LOC", "I-LOC", "B-ORG", "I-ORG"}


# ---------------------------------------------------------------------------
# URL routing
# ---------------------------------------------------------------------------


def get_viewer_urls() -> list:
    """URL patterns mounted under DocumentPageAdmin.get_urls().

    Returned patterns are relative to ``/admin/grime/documentpage/`` — they
    expect the page primary key to follow that prefix.
    """
    return [
        path(
            "<int:page_pk>/viewer/words/correct/",
            word_correct,
            name="grime_documentpage_viewer_word_correct",
        ),
        path(
            "<int:page_pk>/viewer/words/add/",
            word_add,
            name="grime_documentpage_viewer_word_add",
        ),
        path(
            "<int:page_pk>/viewer/words/delete/",
            word_delete,
            name="grime_documentpage_viewer_word_delete",
        ),
        path(
            "<int:page_pk>/viewer/words/ner-correct/",
            word_ner_correct,
            name="grime_documentpage_viewer_word_ner_correct",
        ),
        path(
            "<int:page_pk>/viewer/words/mark-ditto/",
            word_mark_ditto,
            name="grime_documentpage_viewer_word_mark_ditto",
        ),
        path(
            "<int:page_pk>/viewer/words/bulk-delete/",
            words_bulk_delete,
            name="grime_documentpage_viewer_words_bulk_delete",
        ),
        path(
            "<int:page_pk>/viewer/words/bulk-ditto/",
            words_bulk_ditto,
            name="grime_documentpage_viewer_words_bulk_ditto",
        ),
        path(
            "<int:page_pk>/viewer/words/rerun-ocr/",
            words_rerun_ocr,
            name="grime_documentpage_viewer_words_rerun_ocr",
        ),
        path(
            "<int:page_pk>/viewer/words/rerun-ner/",
            words_rerun_ner,
            name="grime_documentpage_viewer_words_rerun_ner",
        ),
        path(
            "<int:page_pk>/viewer/tags/create/",
            tag_create,
            name="grime_documentpage_viewer_tag_create",
        ),
        path(
            "<int:page_pk>/viewer/tags/update/",
            tag_update,
            name="grime_documentpage_viewer_tag_update",
        ),
        path(
            "<int:page_pk>/viewer/tags/delete/",
            tag_delete,
            name="grime_documentpage_viewer_tag_delete",
        ),
    ]


# ---------------------------------------------------------------------------
# Template context
# ---------------------------------------------------------------------------


def _safe_json(payload) -> str:
    return mark_safe(json.dumps(payload).replace("</", "<\\/"))


def _word_to_dict(word: Word | dict) -> dict:
    """Serialise a Word (model or .values() row) for the viewer."""
    if isinstance(word, dict):
        return {
            "id": word["id"],
            "left": word["left"],
            "top": word["top"],
            "width": word["width"],
            "height": word["height"],
            "conf": word["conf"],
            "text": word["corrected_text"] or word["ocr_text"],
            "corrected_text": word["corrected_text"],
            "is_ditto": word.get("is_ditto", False),
            "ner_label": word.get("ner_label"),
            "corrected_label": word.get("corrected_label"),
            "line_num": word["line_num"],
            "word_num": word["word_num"],
        }
    return {
        "id": word.pk,
        "left": word.left,
        "top": word.top,
        "width": word.width,
        "height": word.height,
        "conf": word.conf,
        "text": word.text,
        "corrected_text": word.corrected_text,
        "is_ditto": word.is_ditto,
        "ner_label": word.ner_label,
        "corrected_label": word.corrected_label,
        "line_num": word.line_num,
        "word_num": word.word_num,
    }


def _tag_to_dict(tag: Tag) -> dict:
    return {
        "id": tag.pk,
        "label": tag.label,
        "bbox_left": tag.bbox_left,
        "bbox_top": tag.bbox_top,
        "bbox_width": tag.bbox_width,
        "bbox_height": tag.bbox_height,
        "subcomponents": tag.subcomponents,
        "created_by_id": tag.created_by_id,
    }


def build_viewer_context(page: DocumentPage) -> dict:
    """Build the template context the viewer needs to render and call its endpoints."""
    image_url = page.image.url if page.image else None
    if not image_url:
        return {"image_url": None}

    words = list(
        Word.objects.filter(page=page)
        .order_by("line_num", "word_num")
        .values(
            "id",
            "left",
            "top",
            "width",
            "height",
            "ocr_text",
            "corrected_text",
            "conf",
            "is_ditto",
            "ner_label",
            "corrected_label",
            "line_num",
            "word_num",
        )
    )
    page_ct = ContentType.objects.get_for_model(DocumentPage)
    tags = list(
        Tag.objects.filter(source_type=page_ct, source_id=page.pk).values(
            "id",
            "label",
            "bbox_left",
            "bbox_top",
            "bbox_width",
            "bbox_height",
            "subcomponents",
            "created_by_id",
        )
    )

    def _url(name: str) -> str:
        return reverse(f"grime:{name}", args=[page.pk])

    return {
        "image_url": image_url,
        "image_alt": str(page),
        "ocr_words_json": _safe_json([_word_to_dict(w) for w in words]),
        "tags_json": _safe_json(tags),
        "citations_json": _safe_json([]),
        "prev_url_json": _safe_json(None),
        "next_url_json": _safe_json(None),
        "page_list_json": _safe_json(None),
        "ocr_record_pk": page.pk,
        "tag_source_type_id": page_ct.pk,
        "tag_source_id": page.pk,
        "doc_tag_count": Tag.objects.filter(
            source_type=page_ct,
            source_id__in=page.document.pages.values_list("pk", flat=True),
        ).count(),
        "autogen_unreviewed_count": 0,
        "use_preprocessed_bbox": False,
        # Wired endpoints — the JS gates feature availability on whether each
        # URL is truthy.
        "tag_create_url": _url("grime_documentpage_viewer_tag_create"),
        "tag_update_url": _url("grime_documentpage_viewer_tag_update"),
        "tag_delete_url": _url("grime_documentpage_viewer_tag_delete"),
        "ner_correct_url": _url("grime_documentpage_viewer_word_ner_correct"),
        "ocr_correct_url": _url("grime_documentpage_viewer_word_correct"),
        "ocr_add_word_url": _url("grime_documentpage_viewer_word_add"),
        "ocr_delete_url": _url("grime_documentpage_viewer_word_delete"),
        "ocr_mark_as_ditto_url": _url("grime_documentpage_viewer_word_mark_ditto"),
        "ocr_bulk_delete_url": _url("grime_documentpage_viewer_words_bulk_delete"),
        "ocr_bulk_ditto_url": _url("grime_documentpage_viewer_words_bulk_ditto"),
        "ocr_rerun_selection_url": _url("grime_documentpage_viewer_words_rerun_ocr"),
        "ner_rerun_url": _url("grime_documentpage_viewer_words_rerun_ner"),
        # Not implemented — leave empty so the JS feature-gates them off.
        "ocr_merge_url": "",
        "ocr_reorder_url": "",
        "ocr_join_line_url": "",
        "ocr_confirm_all_url": "",
        "ocr_recluster_url": "",
        "ocr_clear_words_url": "",
        "ocr_resolve_dittos_url": "",
        "ocr_create_person_url": "",
        "rerun_ocr_url": "",
        "review_tags_url": "",
        "prev_url": "",
        "next_url": "",
        "nav_prefix": "",
        "nav_prev_label": "Previous",
        "nav_next_label": "Next",
    }


# ---------------------------------------------------------------------------
# Word endpoints
# ---------------------------------------------------------------------------


def _get_word_on_page(page_pk: int, word_pk_raw) -> Word | None:
    try:
        word_pk = int(word_pk_raw)
    except (TypeError, ValueError):
        return None
    return Word.objects.filter(pk=word_pk, page_id=page_pk).first()


@require_POST
def word_correct(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Update Word.corrected_text. Empty string clears the correction."""
    word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    corrected = (request.POST.get("corrected_text") or "").strip()
    word.corrected_text = corrected or None
    word.corrected_ocr_by = request.user if corrected else None
    word.corrected_ocr_at = timezone.now() if corrected else None
    word.save(update_fields=["corrected_text", "corrected_ocr_by", "corrected_ocr_at"])
    updated = _run_post_ocr(word.page, request)
    return JsonResponse(
        {"ok": True, "corrected_text": word.corrected_text, "updated": updated}
    )


@require_POST
def word_add(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Create a Word at a manually drawn bbox.

    The new Word is appended to line_num=0 with the next available word_num.
    Caller can reorder afterwards.
    """
    page = DocumentPage.objects.filter(pk=page_pk).first()
    if page is None:
        return JsonResponse({"error": "Page not found"}, status=404)
    try:
        left = int(request.POST["left"])
        top = int(request.POST["top"])
        width = int(request.POST["width"])
        height = int(request.POST["height"])
    except (KeyError, ValueError):
        return JsonResponse({"error": "Invalid coordinates"}, status=400)
    if width <= 0 or height <= 0:
        return JsonResponse({"error": "Region must have positive size"}, status=400)

    max_word_num = Word.objects.filter(page=page, line_num=0).aggregate(
        m=Max("word_num")
    )["m"]
    next_word_num = (max_word_num if max_word_num is not None else -1) + 1
    corrected = (request.POST.get("corrected_text") or "").strip()
    now = timezone.now() if corrected else None

    word = Word.objects.create(
        page=page,
        line_num=0,
        word_num=next_word_num,
        left=left,
        top=top,
        width=width,
        height=height,
        conf=0,
        ocr_text="",
        corrected_text=corrected or None,
        corrected_ocr_by=request.user if corrected else None,
        corrected_ocr_at=now,
    )
    updated = _run_post_ocr(page, request)
    return JsonResponse({"ok": True, "word": _word_to_dict(word), "updated": updated})


@require_POST
def word_delete(request: HttpRequest, page_pk: int) -> JsonResponse:
    word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    word_id = word.pk
    page = word.page
    word.delete()
    updated = _run_post_ocr(page, request)
    return JsonResponse({"ok": True, "deleted_id": word_id, "updated": updated})


@require_POST
def word_ner_correct(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Set Word.corrected_label.  Empty string or 'NONE' clears the label."""
    word = _get_word_on_page(page_pk, request.POST.get("word_id"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    label = (request.POST.get("label") or "").strip()
    if label in ("", "NONE"):
        label = None
    if label not in _VALID_NER_LABELS:
        return JsonResponse({"error": f"Invalid label {label!r}"}, status=400)
    word.corrected_label = label
    word.corrected_ner_by = request.user if label else None
    word.corrected_ner_at = timezone.now() if label else None
    word.save(update_fields=["corrected_label", "corrected_ner_by", "corrected_ner_at"])
    return JsonResponse({"ok": True, "word_id": word.pk, "label": label})


# ---------------------------------------------------------------------------
# Tag endpoints
# ---------------------------------------------------------------------------


def _parse_tag_payload(request: HttpRequest) -> tuple[dict, JsonResponse | None]:
    """Parse the bbox + label + subcomponents fields the JS sends with every tag write."""
    try:
        label = (request.POST.get("label") or "").strip()
        if not label:
            return {}, JsonResponse({"error": "label required"}, status=400)
        bbox_left = int(request.POST["bbox_left"])
        bbox_top = int(request.POST["bbox_top"])
        bbox_width = int(request.POST["bbox_width"])
        bbox_height = int(request.POST["bbox_height"])
        subcomponents = json.loads(request.POST.get("subcomponents") or "[]")
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        return {}, JsonResponse({"error": str(exc)}, status=400)
    return {
        "label": label,
        "bbox_left": bbox_left,
        "bbox_top": bbox_top,
        "bbox_width": bbox_width,
        "bbox_height": bbox_height,
        "subcomponents": subcomponents,
    }, None


@require_POST
def tag_create(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Create a Tag on this page.

    The viewer sends source_type_id / source_id in the body for legacy
    reasons; we ignore them and always pin the tag to this page (the URL
    is the source of truth).
    """
    page = DocumentPage.objects.filter(pk=page_pk).first()
    if page is None:
        return JsonResponse({"error": "Page not found"}, status=404)
    fields, err = _parse_tag_payload(request)
    if err is not None:
        return err
    page_ct = ContentType.objects.get_for_model(DocumentPage)
    tag = Tag.objects.create(
        source_type=page_ct,
        source_id=page.pk,
        created_by=request.user,
        **fields,
    )
    return JsonResponse({"ok": True, "tag": _tag_to_dict(tag)})


@require_POST
def tag_update(request: HttpRequest, page_pk: int) -> JsonResponse:
    try:
        tag_id = int(request.POST["tag_id"])
    except (KeyError, ValueError) as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    page_ct = ContentType.objects.get_for_model(DocumentPage)
    tag = Tag.objects.filter(pk=tag_id, source_type=page_ct, source_id=page_pk).first()
    if tag is None:
        return JsonResponse({"error": "Tag not found on this page"}, status=404)
    fields, err = _parse_tag_payload(request)
    if err is not None:
        return err
    for k, v in fields.items():
        setattr(tag, k, v)
    tag.save(update_fields=list(fields.keys()))
    return JsonResponse({"ok": True, "tag": _tag_to_dict(tag)})


@require_POST
def tag_delete(request: HttpRequest, page_pk: int) -> JsonResponse:
    try:
        tag_id = int(request.POST["tag_id"])
    except (KeyError, ValueError) as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    page_ct = ContentType.objects.get_for_model(DocumentPage)
    deleted, _ = Tag.objects.filter(
        pk=tag_id, source_type=page_ct, source_id=page_pk
    ).delete()
    if not deleted:
        return JsonResponse({"error": "Tag not found on this page"}, status=404)
    return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# Ditto / bulk / re-OCR endpoints
# ---------------------------------------------------------------------------


def _parse_word_pks(raw: str | None) -> list[int]:
    if not raw:
        return []
    return [int(p) for p in raw.split(",") if p.strip()]


def _run_post_ocr(page: DocumentPage, request: HttpRequest) -> list[dict]:
    from grime.pipeline.ocr import post_ocr

    return post_ocr(page, user=request.user)


@require_POST
def word_mark_ditto(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Replace one Word's ocr_text with a ditto mark and re-resolve dittos for the page.

    Persists the ditto-resolved correction for any word whose effective text changed,
    so the viewer can refresh those rows from the JSON response without a reload.
    """
    word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    word.ocr_text = '"'
    word.corrected_text = None
    word.is_ditto = False
    word.corrected_ocr_by = None
    word.corrected_ocr_at = None
    word.save(
        update_fields=[
            "ocr_text",
            "corrected_text",
            "is_ditto",
            "corrected_ocr_by",
            "corrected_ocr_at",
        ]
    )
    updated = _run_post_ocr(word.page, request)
    return JsonResponse({"ok": True, "word_pk": word.pk, "updated": updated})


@require_POST
def words_bulk_delete(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Delete several Words at once. Only words belonging to this page are affected."""
    try:
        pks = _parse_word_pks(request.POST.get("word_pks"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    if not pks:
        return JsonResponse({"error": "No word_pks provided"}, status=400)
    qs = Word.objects.filter(pk__in=pks, page_id=page_pk)
    found_ids = list(qs.values_list("pk", flat=True))
    deleted, _ = qs.delete()
    page = DocumentPage.objects.filter(pk=page_pk).first()
    updated = _run_post_ocr(page, request) if page else []
    return JsonResponse(
        {
            "ok": True,
            "deleted_ids": found_ids,
            "deleted": deleted,
            "updated": updated,
        }
    )


@require_POST
def words_bulk_ditto(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Mark several Words as dittos at once, then re-resolve the page.

    Each marked word's text becomes ``"`` and any human correction is cleared;
    ``_resolve_page_dittos`` then walks the page top-to-bottom, projecting the
    most recent word at each horizontal position downward so chained dittos
    fill in correctly.  Words that resolved get their ``corrected_text`` and
    ``is_ditto`` flag persisted.

    Response shape matches the JS expectation: ``marked_pks`` lists the words
    whose raw text was reset to ``"``; ``updated`` lists the words whose
    effective text changed during resolution.
    """
    try:
        pks = _parse_word_pks(request.POST.get("word_pks"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    if not pks:
        return JsonResponse({"error": "No word_pks provided"}, status=400)
    qs = Word.objects.filter(pk__in=pks, page_id=page_pk)
    marked_pks = list(qs.values_list("pk", flat=True))
    if not marked_pks:
        return JsonResponse({"error": "No words found on this page"}, status=404)
    qs.update(
        ocr_text='"',
        corrected_text=None,
        is_ditto=False,
        corrected_ocr_by=None,
        corrected_ocr_at=None,
    )
    page = DocumentPage.objects.get(pk=page_pk)
    updated = _run_post_ocr(page, request)
    return JsonResponse({"ok": True, "marked_pks": marked_pks, "updated": updated})


@require_POST
def words_rerun_ocr(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Re-OCR a Word selection (or the whole page) and return the diff.

    POST params:
      ``word_pks``  comma-separated Word IDs (empty → re-OCR full page)
      ``engine``    ``textract`` | ``tesseract`` | omitted (default: Textract
                    with Tesseract fallback)

    All persistence and engine dispatch happens in
    :func:`grime.pipeline.run_ocr.rerun_selection`; this endpoint only parses
    inputs and shapes the JSON response.
    """
    try:
        pks = _parse_word_pks(request.POST.get("word_pks"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    engine = (request.POST.get("engine") or "").lower() or None
    if engine not in (None, "textract", "tesseract"):
        return JsonResponse({"error": f"Unknown engine: {engine}"}, status=400)

    page = DocumentPage.objects.filter(pk=page_pk).first()
    if page is None:
        return JsonResponse({"error": "Page not found"}, status=404)
    if not page.image:
        return JsonResponse({"error": "Page has no image to re-OCR"}, status=400)

    from grime.pipeline.ocr import rerun_selection

    try:
        result = rerun_selection(page, pks, engine=engine)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"error": f"OCR failed: {exc}"}, status=500)

    return JsonResponse(
        {
            "ok": True,
            "deleted_ids": result["deleted_ids"],
            "new_words": [_word_to_dict(w) for w in result["new_words"]],
        }
    )


@require_POST
def words_rerun_ner(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Run (or re-run) HuggingFace NER on a page and return updated word labels.

    Clears existing NERPass records and ner_label values, then runs the HF NER
    pipeline, saving results as a new NERPass. Returns the full word list with
    updated ner_label fields so the viewer can refresh without a reload.
    """
    page = DocumentPage.objects.filter(pk=page_pk).first()
    if page is None:
        return JsonResponse({"error": "Page not found"}, status=404)

    from grime.models import NERPass, Word
    from grime.pipeline.ner import DEFAULT_CONFIDENCE_THRESHOLD, extract_entities, label_ocr_words

    SCHEMA_NAME = "hf-historical-ner"
    try:
        NERPass.objects.filter(page=page, schema_name=SCHEMA_NAME).delete()
        words = list(Word.objects.filter(page=page).order_by("line_num", "word_num"))
        if not words:
            return JsonResponse({"error": "Page has no words to run NER on"}, status=400)
        Word.objects.filter(page=page).update(ner_label=None)
        text = page.text or " ".join(
            (w.corrected_text if w.corrected_text is not None else w.ocr_text) or ""
            for w in words
        )
        if not text.strip():
            return JsonResponse({"error": "Page has no text to run NER on"}, status=400)
        entities = extract_entities(text, confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD)
        ner_pass = NERPass.objects.create(
            page=page,
            schema_name=SCHEMA_NAME,
            method="hf-historical-ner",
            used_llm=False,
            threshold=DEFAULT_CONFIDENCE_THRESHOLD,
            status=NERPass.STATUS_COMPLETE,
        )
        label_ocr_words(words, text, entities)
        labelled = [w for w in words if w.ner_label]
        if labelled:
            for w in labelled:
                w.ner_pass = ner_pass
            Word.objects.bulk_update(labelled, ["ner_pass"])
    except Exception as exc:
        return JsonResponse({"error": f"NER failed: {exc}"}, status=500)

    words = list(
        Word.objects.filter(page=page)
        .order_by("line_num", "word_num")
        .values("id", "ner_label", "corrected_label")
    )
    return JsonResponse({"ok": True, "words": words})


# ---------------------------------------------------------------------------
# Document detail view
# ---------------------------------------------------------------------------


@staff_member_required
def document_page_view(request, doc_pk: int, page_pk: int | None = None):
    doc = get_object_or_404(Document, pk=doc_pk)
    pages = list(doc.pages.order_by("page_number"))

    if not pages:
        return render(
            request, "grime/document_detail.html", {"document": doc, "image_url": None}
        )

    if page_pk is None:
        return redirect("grime:document_page", doc_pk=doc_pk, page_pk=pages[0].pk)

    page = get_object_or_404(DocumentPage, pk=page_pk, document=doc)
    page_pks = [p.pk for p in pages]
    idx = page_pks.index(page.pk)

    def _page_url(pk: int) -> str:
        return reverse("grime:document_page", args=[doc_pk, pk])

    prev_pk = page_pks[idx - 1] if idx > 0 else None
    next_pk = page_pks[idx + 1] if idx < len(page_pks) - 1 else None

    ctx = build_viewer_context(page)
    ctx.update(
        {
            "document": doc,
            "prev_url": _page_url(prev_pk) if prev_pk else "",
            "next_url": _page_url(next_pk) if next_pk else "",
            "prev_url_json": _safe_json(_page_url(prev_pk) if prev_pk else None),
            "next_url_json": _safe_json(_page_url(next_pk) if next_pk else None),
            "page_list_json": _safe_json(
                [
                    {"pk": p.pk, "page_number": p.page_number, "url": _page_url(p.pk)}
                    for p in pages
                ]
            ),
            "page_position": idx + 1,
            "total_count": len(pages),
            "nav_prefix": "",
        }
    )
    return render(request, "grime/document_detail.html", ctx)


# ---------------------------------------------------------------------------
# Landing page
# ---------------------------------------------------------------------------


@staff_member_required
def document_list_view(request):
    upload_error = None
    form = DocumentUploadForm()

    if request.method == "POST":
        form = DocumentUploadForm(request.POST, request.FILES)
        if form.is_valid():
            uploaded = form.cleaned_data["pdf_file"]
            title = form.cleaned_data.get("title") or None
            stem = Path(uploaded.name).stem

            tmp_dir = tempfile.mkdtemp()
            tmp_path = Path(tmp_dir) / f"{stem}.pdf"
            try:
                with open(tmp_path, "wb") as fh:
                    for chunk in uploaded.chunks():
                        fh.write(chunk)
                from grime.pipeline.ingest import ingest_pdf

                doc, _, _ = ingest_pdf(tmp_path, title=title)
            except Exception as exc:
                upload_error = str(exc)
                doc = None
            finally:
                tmp_path.unlink(missing_ok=True)
                os.rmdir(tmp_dir)

            if doc is not None:
                return redirect("grime:document", doc_pk=doc.pk)

    documents = (
        Document.objects.annotate(page_count=Count("pages")).order_by("title")
    )
    return render(
        request,
        "grime/document_list.html",
        {"documents": documents, "form": form, "upload_error": upload_error},
    )
