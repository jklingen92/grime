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
    POST words/ner-correct/   — set Word.corrected_ner_label
    POST tags/create/         — create a Tag on this page
    POST tags/update/         — edit an existing Tag
    POST tags/delete/         — delete a Tag

Word ops are scoped to the page in the URL — the view rejects requests
that try to touch a Word belonging to a different page.
"""

import json

from django.contrib.contenttypes.models import ContentType
from django.db.models import Max
from django.http import HttpRequest, JsonResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_POST

from grime.models import DocumentPage, Tag, Word

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
            "text": word["text"],
            "corrected_text": word["corrected_text"],
            "is_ditto": word.get("is_ditto", False),
            "ner_label": word.get("ner_label"),
            "corrected_ner_label": word.get("corrected_ner_label"),
            "block_num": word["block_num"],
            "par_num": word["par_num"],
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
        "corrected_ner_label": word.corrected_ner_label,
        "block_num": word.block_num,
        "par_num": word.par_num,
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
        .order_by("block_num", "par_num", "line_num", "word_num")
        .values(
            "id",
            "left",
            "top",
            "width",
            "height",
            "text",
            "corrected_text",
            "conf",
            "is_ditto",
            "ner_label",
            "corrected_ner_label",
            "block_num",
            "par_num",
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
        return reverse(f"admin:{name}", args=[page.pk])

    return {
        "image_url": image_url,
        "image_alt": str(page),
        "ocr_words_json": _safe_json([_word_to_dict(w) for w in words]),
        "tags_json": _safe_json(tags),
        "citations_json": _safe_json([]),
        "prev_url_json": _safe_json(None),
        "next_url_json": _safe_json(None),
        "page_list_json": _safe_json(None),
        # `ocr_record_pk` is the viewer template's flag for "OCR editing is on".
        # We don't track an OCRRecord anymore but want the editing UI when the
        # page has any words at all.
        "ocr_record_pk": page.pk if words else None,
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
        # Not implemented yet — leave empty so the JS feature-gates them off.
        "ocr_merge_url": "",
        "ocr_reorder_url": "",
        "ocr_join_line_url": "",
        "ocr_confirm_all_url": "",
        "ocr_recluster_url": "",
        "ocr_clear_words_url": "",
        "ocr_resolve_dittos_url": "",
        "ocr_mark_as_ditto_url": "",
        "ocr_bulk_ditto_url": "",
        "ocr_bulk_delete_url": "",
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
    word.corrected_by = request.user if corrected else None
    word.corrected_at = timezone.now() if corrected else None
    word.save(update_fields=["corrected_text", "corrected_by", "corrected_at"])
    return JsonResponse({"ok": True, "corrected_text": word.corrected_text})


@require_POST
def word_add(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Create a Word at a manually drawn bbox.

    The new Word is appended to line_num=0 with the next available word_num,
    matching klancestry's add-region behaviour.  Caller can reorder afterwards.
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

    max_word_num = Word.objects.filter(
        page=page, block_num=0, par_num=0, line_num=0
    ).aggregate(m=Max("word_num"))["m"]
    next_word_num = (max_word_num if max_word_num is not None else -1) + 1
    corrected = (request.POST.get("corrected_text") or "").strip()
    now = timezone.now() if corrected else None

    word = Word.objects.create(
        page=page,
        block_num=0,
        par_num=0,
        line_num=0,
        word_num=next_word_num,
        left=left,
        top=top,
        width=width,
        height=height,
        conf=0,
        text="",
        corrected_text=corrected or None,
        corrected_by=request.user if corrected else None,
        corrected_at=now,
    )
    return JsonResponse({"ok": True, "word": _word_to_dict(word)})


@require_POST
def word_delete(request: HttpRequest, page_pk: int) -> JsonResponse:
    word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    word_id = word.pk
    word.delete()
    return JsonResponse({"ok": True, "deleted_id": word_id})


@require_POST
def word_ner_correct(request: HttpRequest, page_pk: int) -> JsonResponse:
    """Set Word.corrected_ner_label.  Empty string or 'NONE' clears the label."""
    word = _get_word_on_page(page_pk, request.POST.get("word_id"))
    if word is None:
        return JsonResponse({"error": "Word not found on this page"}, status=404)
    label = (request.POST.get("label") or "").strip()
    if label in ("", "NONE"):
        label = None
    if label not in _VALID_NER_LABELS:
        return JsonResponse({"error": f"Invalid label {label!r}"}, status=400)
    word.corrected_ner_label = label
    word.corrected_ner_by = request.user if label else None
    word.corrected_ner_at = timezone.now() if label else None
    word.save(
        update_fields=["corrected_ner_label", "corrected_ner_by", "corrected_ner_at"]
    )
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
