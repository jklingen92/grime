"""
Viewer AJAX endpoints and template-context wiring.

All JSON endpoints are rooted under ``/pages/<page_pk>/viewer/`` and
registered via ``get_viewer_urls()``, which is included from ``grime/urls.py``.
Endpoints are staff-only via ``PageEndpointMixin``.

Endpoints:

    POST words/correct/       — set Word.corrected_text
    POST words/add/           — create a new Word at a drawn bbox
    POST words/delete/        — delete a Word
    POST words/ner-correct/   — set Word.corrected_label
    POST words/mark-ditto/    — mark one Word as a ditto and re-resolve the page
    POST words/bulk-delete/   — delete multiple Words at once
    POST words/bulk-ditto/    — mark multiple Words as dittos and re-resolve the page
    POST words/rerun-ner/     — run HuggingFace NER on the page
    POST annotations/create/  — create an Annotation on this page
    POST annotations/update/  — edit an existing Annotation
    POST annotations/delete/  — delete an Annotation
    POST image/save/          — bake brightness/contrast/levels into corrected_image
    POST image/reset/         — clear corrected_image and revert to original
    POST image/autocontrast/  — analyse histogram and return suggested black/white levels
    GET  export/pdf/          — download a single page as a searchable PDF

Word ops are scoped to the page in the URL — requests touching a Word
belonging to a different page are rejected.
"""

import io
import json
from pathlib import Path

from django.contrib.contenttypes.models import ContentType
from django.db.models import Max
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import path, reverse
from django.utils import timezone
from django.utils.safestring import mark_safe
from django.views import View

from grime.mixins import StaffRequiredMixin
from grime.models import Annotation, DocumentPage, Word

_VALID_NER_LABELS = {None, "", "B-PER", "I-PER", "B-LOC", "I-LOC", "B-ORG", "I-ORG"}


# ---------------------------------------------------------------------------
# Mixins
# ---------------------------------------------------------------------------


class PageEndpointMixin(StaffRequiredMixin, View):
    """Base for viewer AJAX endpoints scoped to a DocumentPage. POST-only."""
    http_method_names = ['post']

    def get_page(self):
        return DocumentPage.objects.filter(pk=self.kwargs['page_pk']).first()


# ---------------------------------------------------------------------------
# URL routing
# ---------------------------------------------------------------------------


def get_viewer_urls() -> list:
    """URL patterns included under ``pages/`` in grime/urls.py."""
    return [
        path(
            "<int:page_pk>/viewer/words/correct/",
            WordCorrectView.as_view(),
            name="grime_documentpage_viewer_word_correct",
        ),
        path(
            "<int:page_pk>/viewer/words/add/",
            WordAddView.as_view(),
            name="grime_documentpage_viewer_word_add",
        ),
        path(
            "<int:page_pk>/viewer/words/delete/",
            WordDeleteView.as_view(),
            name="grime_documentpage_viewer_word_delete",
        ),
        path(
            "<int:page_pk>/viewer/words/ner-correct/",
            WordNerCorrectView.as_view(),
            name="grime_documentpage_viewer_word_ner_correct",
        ),
        path(
            "<int:page_pk>/viewer/words/mark-ditto/",
            WordMarkDittoView.as_view(),
            name="grime_documentpage_viewer_word_mark_ditto",
        ),
        path(
            "<int:page_pk>/viewer/words/bulk-delete/",
            WordsBulkDeleteView.as_view(),
            name="grime_documentpage_viewer_words_bulk_delete",
        ),
        path(
            "<int:page_pk>/viewer/words/bulk-ditto/",
            WordsBulkDittoView.as_view(),
            name="grime_documentpage_viewer_words_bulk_ditto",
        ),
        path(
            "<int:page_pk>/viewer/words/rerun-ner/",
            WordsRerunNerView.as_view(),
            name="grime_documentpage_viewer_words_rerun_ner",
        ),
        path(
            "<int:page_pk>/viewer/annotations/create/",
            AnnotationCreateView.as_view(),
            name="grime_documentpage_viewer_annotation_create",
        ),
        path(
            "<int:page_pk>/viewer/annotations/update/",
            AnnotationUpdateView.as_view(),
            name="grime_documentpage_viewer_annotation_update",
        ),
        path(
            "<int:page_pk>/viewer/annotations/delete/",
            AnnotationDeleteView.as_view(),
            name="grime_documentpage_viewer_annotation_delete",
        ),
        path(
            "<int:page_pk>/viewer/image/save/",
            ImageSaveView.as_view(),
            name="grime_documentpage_viewer_image_save",
        ),
        path(
            "<int:page_pk>/viewer/image/reset/",
            ImageResetView.as_view(),
            name="grime_documentpage_viewer_image_reset",
        ),
        path(
            "<int:page_pk>/viewer/image/autocontrast/",
            ImageAutocontrastView.as_view(),
            name="grime_documentpage_viewer_image_autocontrast",
        ),
        path(
            "<int:page_pk>/viewer/export/pdf/",
            ExportPagePdfView.as_view(),
            name="grime_documentpage_viewer_export_pdf",
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
            "ocr_text": word["ocr_text"],
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
        "ocr_text": word.ocr_text,
        "corrected_text": word.corrected_text,
        "is_ditto": word.is_ditto,
        "ner_label": word.ner_label,
        "corrected_label": word.corrected_label,
        "line_num": word.line_num,
        "word_num": word.word_num,
    }


def _annotation_to_dict(annotation: Annotation) -> dict:
    return {
        "id": annotation.pk,
        "label": annotation.label,
        "bbox_left": annotation.bbox_left,
        "bbox_top": annotation.bbox_top,
        "bbox_width": annotation.bbox_width,
        "bbox_height": annotation.bbox_height,
        "subcomponents": annotation.subcomponents,
        "created_by_id": annotation.created_by_id,
    }


from grime.pipeline.ner import DEFAULT_MODEL as _NER_DEFAULT_MODEL
from grime.pipeline.ner import MODEL_LABELS as _NER_MODEL_LABELS
from grime.pipeline.ner import MODEL_REGISTRY as _NER_MODEL_REGISTRY


def build_viewer_context(page: DocumentPage) -> dict:
    """Build the template context the viewer needs to render and call its endpoints."""
    image_url = page.display_image.url if page.display_image else None
    if not image_url:
        return {"image_url": None}
    original_image_url = page.image.url if page.image else image_url

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
    annotations = list(
        Annotation.objects.filter(source_type=page_ct, source_id=page.pk).values(
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

    ner_models = [
        {"key": k, "label": _NER_MODEL_LABELS.get(k, k.capitalize()), "default": k == _NER_DEFAULT_MODEL}
        for k in _NER_MODEL_REGISTRY
    ]

    def _url(name: str) -> str:
        return reverse(f"grime:{name}", args=[page.pk])

    return {
        "image_url": image_url,
        "original_image_url": original_image_url,
        "image_has_corrected": bool(page.corrected_image),
        "image_adjustments_json": _safe_json(page.image_adjustments),
        "image_alt": str(page),
        "ner_models_json": _safe_json(ner_models),
        "ocr_words_json": _safe_json([_word_to_dict(w) for w in words]),
        "annotations_json": _safe_json(annotations),
        "citations_json": _safe_json([]),
        "prev_url_json": _safe_json(None),
        "next_url_json": _safe_json(None),
        "page_list_json": _safe_json(None),
        "ocr_record_pk": page.pk,
        "confirmed_word_count": Word.objects.filter(page=page, corrected_ocr_by__isnull=False).count(),
        "annotation_source_type_id": page_ct.pk,
        "annotation_source_id": page.pk,
        "doc_annotation_count": Annotation.objects.filter(
            source_type=page_ct,
            source_id__in=page.document.pages.values_list("pk", flat=True),
        ).count(),
        "autogen_unreviewed_count": 0,
        "use_preprocessed_bbox": False,
        # Wired endpoints — the JS gates feature availability on whether each URL is truthy.
        "annotation_create_url": _url("grime_documentpage_viewer_annotation_create"),
        "annotation_update_url": _url("grime_documentpage_viewer_annotation_update"),
        "annotation_delete_url": _url("grime_documentpage_viewer_annotation_delete"),
        "export_pdf_url": _url("grime_documentpage_viewer_export_pdf"),
        "image_save_url": _url("grime_documentpage_viewer_image_save"),
        "image_reset_url": _url("grime_documentpage_viewer_image_reset"),
        "image_autocontrast_url": _url("grime_documentpage_viewer_image_autocontrast"),
        "ner_correct_url": _url("grime_documentpage_viewer_word_ner_correct"),
        "ocr_correct_url": _url("grime_documentpage_viewer_word_correct"),
        "ocr_add_word_url": _url("grime_documentpage_viewer_word_add"),
        "ocr_delete_url": _url("grime_documentpage_viewer_word_delete"),
        "ocr_mark_as_ditto_url": _url("grime_documentpage_viewer_word_mark_ditto"),
        "ocr_bulk_delete_url": _url("grime_documentpage_viewer_words_bulk_delete"),
        "ocr_bulk_ditto_url": _url("grime_documentpage_viewer_words_bulk_ditto"),
        "ocr_rerun_selection_url": "",
        "ner_rerun_url": "",
        "job_create_url": reverse("grime:job_create"),
        "job_poll_url_tpl": reverse("grime:job_poll", args=[0]).replace("/0/", "/{pk}/"),
        "job_form_fields_url": reverse("grime:job_form_fields"),
        "job_status_url": reverse("grime:jobs_status"),
        "document_pk": page.document_id,
        # Not implemented — leave empty so JS feature-gates them off.
        "ocr_merge_url": "",
        "ocr_reorder_url": "",
        "ocr_join_line_url": "",
        "ocr_confirm_all_url": "",
        "ocr_recluster_url": "",
        "ocr_clear_words_url": "",
        "ocr_resolve_dittos_url": "",
        "ocr_create_person_url": "",
        "rerun_ocr_url": "",
        "review_annotations_url": "",
        "prev_url": "",
        "next_url": "",
        "nav_prefix": "",
        "nav_prev_label": "Previous",
        "nav_next_label": "Next",
    }


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _get_word_on_page(page_pk: int, word_pk_raw) -> Word | None:
    try:
        word_pk = int(word_pk_raw)
    except (TypeError, ValueError):
        return None
    return Word.objects.filter(pk=word_pk, page_id=page_pk).first()


def _parse_word_pks(raw: str | None) -> list[int]:
    if not raw:
        return []
    return [int(p) for p in raw.split(",") if p.strip()]


def _run_post_ocr(page: DocumentPage, request) -> list[dict]:
    from grime.pipeline.ocr import post_ocr
    return post_ocr(page, user=request.user)


def _parse_annotation_payload(request) -> tuple[dict, JsonResponse | None]:
    """Parse the bbox + label + subcomponents fields the JS sends with every annotation write."""
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


# ---------------------------------------------------------------------------
# Word endpoints
# ---------------------------------------------------------------------------


class WordCorrectView(PageEndpointMixin):
    """Update Word.corrected_text. Empty string clears the correction."""

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
        if word is None:
            return JsonResponse({"error": "Word not found on this page"}, status=404)
        corrected = (request.POST.get("corrected_text") or "").strip()
        word.corrected_text = corrected or None
        word.corrected_ocr_by = request.user if corrected else None
        word.corrected_ocr_at = timezone.now() if corrected else None
        word.save(update_fields=["corrected_text", "corrected_ocr_by", "corrected_ocr_at"])
        updated = _run_post_ocr(word.page, request)
        return JsonResponse({"ok": True, "corrected_text": word.corrected_text, "updated": updated})


class WordAddView(PageEndpointMixin):
    """Create a Word at a manually drawn bbox, appended to line_num=0."""

    def post(self, request, *args, **kwargs):
        page = self.get_page()
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
        max_word_num = Word.objects.filter(page=page, line_num=0).aggregate(m=Max("word_num"))["m"]
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


class WordDeleteView(PageEndpointMixin):

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
        if word is None:
            return JsonResponse({"error": "Word not found on this page"}, status=404)
        word_id = word.pk
        page = word.page
        word.delete()
        if not page.words.exists():
            page.ocr_passes.all().delete()
        updated = _run_post_ocr(page, request)
        return JsonResponse({"ok": True, "deleted_id": word_id, "updated": updated})


class WordNerCorrectView(PageEndpointMixin):
    """Set Word.corrected_label. 'NONE' stores '' (explicitly cleared, overrides ner_label)."""

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        word = _get_word_on_page(page_pk, request.POST.get("word_id"))
        if word is None:
            return JsonResponse({"error": "Word not found on this page"}, status=404)
        raw = (request.POST.get("label") or "").strip()
        label = "" if raw == "NONE" else raw or None
        if label not in _VALID_NER_LABELS:
            return JsonResponse({"error": f"Invalid label {label!r}"}, status=400)
        word.corrected_label = label
        word.corrected_ner_by = request.user if label is not None else None
        word.corrected_ner_at = timezone.now() if label is not None else None
        word.save(update_fields=["corrected_label", "corrected_ner_by", "corrected_ner_at"])
        return JsonResponse({"ok": True, "word_id": word.pk, "label": label})


class WordMarkDittoView(PageEndpointMixin):
    """Replace one Word's ocr_text with a ditto mark and re-resolve dittos for the page."""

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        word = _get_word_on_page(page_pk, request.POST.get("word_pk"))
        if word is None:
            return JsonResponse({"error": "Word not found on this page"}, status=404)
        word.ocr_text = '"'
        word.corrected_text = None
        word.is_ditto = False
        word.corrected_ocr_by = None
        word.corrected_ocr_at = None
        word.save(update_fields=["ocr_text", "corrected_text", "is_ditto", "corrected_ocr_by", "corrected_ocr_at"])
        updated = _run_post_ocr(word.page, request)
        return JsonResponse({"ok": True, "word_pk": word.pk, "updated": updated})


class WordsBulkDeleteView(PageEndpointMixin):
    """Delete several Words at once. Only words belonging to this page are affected."""

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
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
        if page and not page.words.exists():
            page.ocr_passes.all().delete()
        updated = _run_post_ocr(page, request) if page else []
        return JsonResponse({"ok": True, "deleted_ids": found_ids, "deleted": deleted, "updated": updated})


class WordsBulkDittoView(PageEndpointMixin):
    """Mark several Words as dittos at once, then re-resolve the page."""

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
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


class WordsRerunNerView(PageEndpointMixin):
    """Run (or re-run) HuggingFace NER on a page and return updated word labels.

    POST params:
      ``model``  NER model key (optional; defaults to DEFAULT_MODEL).
    """

    def post(self, request, *args, **kwargs):
        page = self.get_page()
        if page is None:
            return JsonResponse({"error": "Page not found"}, status=404)

        from grime.models import NERPass
        from grime.pipeline.ner import DEFAULT_CONFIDENCE_THRESHOLD, extract_entities, label_ocr_words

        model_key = (request.POST.get("model") or _NER_DEFAULT_MODEL).strip()
        if model_key not in _NER_MODEL_REGISTRY:
            return JsonResponse(
                {"error": f"Unknown model {model_key!r}. Valid keys: {', '.join(_NER_MODEL_REGISTRY)}"},
                status=400,
            )
        schema_name = f"hf-ner-{model_key}"
        try:
            NERPass.objects.filter(page=page, schema_name=schema_name).delete()
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
            entities = extract_entities(text, confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD, model=model_key)
            ner_pass = NERPass.objects.create(
                page=page,
                schema_name=schema_name,
                method=f"hf-ner-{model_key}",
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
        return JsonResponse({"ok": True, "words": words, "model": model_key})


# ---------------------------------------------------------------------------
# Annotation endpoints
# ---------------------------------------------------------------------------


class AnnotationCreateView(PageEndpointMixin):
    """Create an Annotation pinned to this page (URL is the source of truth)."""

    def post(self, request, *args, **kwargs):
        page = self.get_page()
        if page is None:
            return JsonResponse({"error": "Page not found"}, status=404)
        fields, err = _parse_annotation_payload(request)
        if err is not None:
            return err
        page_ct = ContentType.objects.get_for_model(DocumentPage)
        annotation = Annotation.objects.create(
            source_type=page_ct,
            source_id=page.pk,
            created_by=request.user,
            **fields,
        )
        return JsonResponse({"ok": True, "annotation": _annotation_to_dict(annotation)})


class AnnotationUpdateView(PageEndpointMixin):

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        try:
            annotation_id = int(request.POST["annotation_id"])
        except (KeyError, ValueError) as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        page_ct = ContentType.objects.get_for_model(DocumentPage)
        annotation = Annotation.objects.filter(
            pk=annotation_id, source_type=page_ct, source_id=page_pk
        ).first()
        if annotation is None:
            return JsonResponse({"error": "Annotation not found on this page"}, status=404)
        fields, err = _parse_annotation_payload(request)
        if err is not None:
            return err
        for k, v in fields.items():
            setattr(annotation, k, v)
        annotation.save(update_fields=list(fields.keys()))
        return JsonResponse({"ok": True, "annotation": _annotation_to_dict(annotation)})


class AnnotationDeleteView(PageEndpointMixin):

    def post(self, request, *args, **kwargs):
        page_pk = self.kwargs['page_pk']
        try:
            annotation_id = int(request.POST["annotation_id"])
        except (KeyError, ValueError) as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        page_ct = ContentType.objects.get_for_model(DocumentPage)
        deleted, _ = Annotation.objects.filter(
            pk=annotation_id, source_type=page_ct, source_id=page_pk
        ).delete()
        if not deleted:
            return JsonResponse({"error": "Annotation not found on this page"}, status=404)
        return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# Image adjustment endpoints
# ---------------------------------------------------------------------------

# Identity adjustments. Must match the DEFAULTS object in viewer-image.js after
# the slider->params conversion done there (brightness/100, contrast/100, etc.).
_DEFAULT_IMAGE_PARAMS = {
    "brightness": 0.0,
    "contrast": 1.0,
    "gamma": 1.0,
    "black": 0,
    "white": 255,
    "grayscale": False,
    "invert": False,
    "threshold": None,
    "sharpen": False,
    "rotate90": 0,
    "rotate_fine": 0.0,
}


def _build_image_lut(params: dict) -> list[int]:
    """Per-channel 0-255 LUT. Mirrors buildLut() in viewer-image.js exactly."""
    black = max(0, min(255, int(params.get("black", 0))))
    white = max(black + 1, min(255, int(params.get("white", 255))))
    gamma = max(0.01, float(params.get("gamma", 1.0)))
    contrast = float(params.get("contrast", 1.0))
    brightness = float(params.get("brightness", 0.0))
    span = white - black
    inv_gamma = 1.0 / gamma
    lut = []
    for i in range(256):
        x = (i - black) / span
        if x < 0.0:
            x = 0.0
        elif x > 1.0:
            x = 1.0
        x = x ** inv_gamma
        x = (x - 0.5) * contrast + 0.5
        x = x + brightness
        if x < 0.0:
            x = 0.0
        elif x > 1.0:
            x = 1.0
        lut.append(int(round(x * 255)))
    return lut


def _apply_image_adjustments(im, params: dict):
    from PIL import Image as _Image, ImageFilter, ImageOps

    if im.mode not in ("L", "RGB", "RGBA"):
        im = im.convert("RGB")

    # 1. LUT (brightness / contrast / gamma / levels)
    lut = _build_image_lut(params)
    bands = im.getbands()
    identity = list(range(256))
    full = []
    for b in bands:
        full.extend(identity if b == "A" else lut)
    im = im.point(full)

    # 2. Grayscale — convert to L then back to RGB so downstream steps stay uniform
    if params.get("grayscale"):
        if im.mode == "RGBA":
            gray = im.convert("L").convert("RGBA")
            gray.putalpha(im.split()[3])
            im = gray
        else:
            im = im.convert("L").convert("RGB")

    # 3. Invert — ImageOps.invert doesn't support RGBA, so split the alpha out
    if params.get("invert"):
        if im.mode == "RGBA":
            r, g, b, a = im.split()
            rgb = ImageOps.invert(_Image.merge("RGB", (r, g, b)))
            im = _Image.merge("RGBA", (*rgb.split(), a))
        else:
            im = ImageOps.invert(im.convert("RGB"))

    # 4. Threshold / binarize
    threshold = params.get("threshold")
    if threshold is not None:
        t = int(threshold)
        gray = im.convert("L")
        thresholded = gray.point(lambda p: 255 if p > t else 0)
        im = thresholded.convert("RGBA" if im.mode == "RGBA" else "RGB")

    # 5. Sharpen (unsharp mask — no live preview, only baked on save)
    if params.get("sharpen"):
        work = im if im.mode in ("L", "RGB") else im.convert("RGB")
        im = work.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))

    # 6. Rotate (positive = clockwise; Pillow rotates CCW so we negate)
    rotate90 = int(params.get("rotate90") or 0) % 4
    rotate_fine = float(params.get("rotate_fine") or 0.0)
    total_cw = rotate90 * 90 + rotate_fine
    if total_cw:
        fill = (255, 255, 255) if im.mode in ("RGB", "RGBA") else 255
        im = im.rotate(-total_cw, expand=True, fillcolor=fill, resample=_Image.BICUBIC)

    return im


class ImageSaveView(PageEndpointMixin):
    """Bake brightness/contrast/levels params into ``corrected_image``."""

    def post(self, request, *args, **kwargs):
        from django.core.files.base import ContentFile
        from PIL import Image

        page = self.get_page()
        if page is None:
            return JsonResponse({"error": "Page not found"}, status=404)
        if not page.image:
            return JsonResponse({"error": "Page has no source image"}, status=400)
        try:
            body = json.loads((request.body or b"{}").decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        params = {**_DEFAULT_IMAGE_PARAMS, **(body or {})}
        with Image.open(page.image.path) as im:
            im.load()
            adjusted = _apply_image_adjustments(im, params)
            buf = io.BytesIO()
            adjusted.save(buf, format="PNG")
        fname = f"{Path(page.image.name).stem}-corrected.png"
        if page.corrected_image:
            page.corrected_image.delete(save=False)
        page.corrected_image.save(fname, ContentFile(buf.getvalue()), save=False)
        page.image_adjustments = params
        page.corrected_image_by = request.user
        page.corrected_image_at = timezone.now()
        page.save(update_fields=["corrected_image", "image_adjustments", "corrected_image_by", "corrected_image_at"])
        return JsonResponse({"ok": True, "image_url": page.corrected_image.url, "adjustments": params})


class ImageResetView(PageEndpointMixin):
    """Drop ``corrected_image`` and revert to the original ``image``."""

    def post(self, request, *args, **kwargs):
        page = self.get_page()
        if page is None:
            return JsonResponse({"error": "Page not found"}, status=404)
        if page.corrected_image:
            page.corrected_image.delete(save=False)
        page.corrected_image = None
        page.image_adjustments = None
        page.corrected_image_by = None
        page.corrected_image_at = None
        page.save(update_fields=["corrected_image", "image_adjustments", "corrected_image_by", "corrected_image_at"])
        return JsonResponse({"ok": True, "image_url": page.image.url if page.image else None})


class ImageAutocontrastView(PageEndpointMixin):
    """Analyse the source image histogram and return suggested black/white levels.

    Uses a 1% cutoff on each end of the luminance distribution. The returned
    ``black`` / ``white`` values can be dropped straight into the JS slider state.
    """

    def post(self, request, *args, **kwargs):
        from PIL import Image

        page = self.get_page()
        if page is None:
            return JsonResponse({"error": "Page not found"}, status=404)
        if not page.image:
            return JsonResponse({"error": "Page has no source image"}, status=400)
        with Image.open(page.image.path) as im:
            gray = im.convert("L")
            hist = gray.histogram()  # 256 counts
        total = sum(hist)
        cutoff = total * 0.01
        black = 0
        cumsum = 0
        for i, count in enumerate(hist):
            cumsum += count
            if cumsum >= cutoff:
                black = i
                break
        white = 255
        cumsum = 0
        for i, count in enumerate(reversed(hist)):
            cumsum += count
            if cumsum >= cutoff:
                white = 255 - i
                break
        white = max(black + 1, white)
        return JsonResponse({"ok": True, "black": black, "white": white})


# ---------------------------------------------------------------------------
# PDF export
# ---------------------------------------------------------------------------


class ExportPagePdfView(StaffRequiredMixin, View):
    """Download a single page as a searchable sandwich PDF.

    Query params:
        confirmed_only=1  — include only words with a manual correction
    """

    def get(self, request, page_pk):
        page = get_object_or_404(DocumentPage, pk=page_pk)
        confirmed_only = request.GET.get("confirmed_only") == "1"
        from grime.pipeline.export import export_document_pdf
        buf = io.BytesIO()
        export_document_pdf(page.document, buf, confirmed_only=confirmed_only, page_pks=[page.pk])
        buf.seek(0)
        slug = str(page).replace(" ", "_").replace("/", "-")[:60]
        response = HttpResponse(buf, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{slug}.pdf"'
        return response
