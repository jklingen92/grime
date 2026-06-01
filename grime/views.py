"""
Page-rendering views for documents and entities.

These are the browser-facing views — they render templates or return file
downloads. Viewer AJAX endpoints live in grime/viewer.py; job endpoints
live in grime/views_jobs.py.
"""

import io
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path

from django.db.models import Count
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views import View

from grime.forms import DocumentUploadForm
from grime.mixins import StaffRequiredMixin
from grime.models import Document, DocumentPage, Entity, Word, WorkerSlot
from grime.viewer import _safe_json, build_viewer_context

_ENTITY_TYPE_LABELS = {"PER": "Person", "LOC": "Location", "ORG": "Organization"}
_VALID_ENTITY_TYPES = set(_ENTITY_TYPE_LABELS)


def _build_entity_spans(words) -> list[dict]:
    """Group BIO-labelled words into entity spans.

    Mirrors nerBuildEntities() in viewer-ner.js. Returns a list of:
        {'type': 'PER', 'text': 'John Smith',
         'bbox': {'left':…, 'top':…, 'width':…, 'height':…}}
    """
    spans = []
    current = None
    for w in words:
        label = w.label if hasattr(w, "label") else (w.get("corrected_label") or w.get("ner_label"))
        if not label:
            current = None
            continue
        entity_type = label[2:]
        prefix = label[0]
        if prefix == "B" or current is None or current["type"] != entity_type:
            current = {"type": entity_type, "words": [w]}
            spans.append(current)
        else:
            current["words"].append(w)

    result = []
    for s in spans:
        ws = s["words"]
        text = " ".join(
            (w.corrected_text or w.ocr_text) if hasattr(w, "ocr_text")
            else (w.get("corrected_text") or w.get("ocr_text", ""))
            for w in ws
        )
        left   = min(w.left if hasattr(w, "left") else w["left"] for w in ws)
        top    = min(w.top  if hasattr(w, "top")  else w["top"]  for w in ws)
        right  = max((w.left + w.width)  if hasattr(w, "left") else (w["left"] + w["width"])  for w in ws)
        bottom = max((w.top  + w.height) if hasattr(w, "top")  else (w["top"]  + w["height"]) for w in ws)
        result.append({
            "type": s["type"],
            "text": text,
            "bbox": {"left": left, "top": top, "width": right - left, "height": bottom - top},
        })
    return result


# ---------------------------------------------------------------------------
# Document list / upload
# ---------------------------------------------------------------------------


class DocumentListView(StaffRequiredMixin, View):
    template_name = "grime/document_list.html"

    def get(self, request):
        return render(request, self.template_name, self._build_context())

    def post(self, request):
        form = DocumentUploadForm(request.POST, request.FILES)
        upload_error = None
        if form.is_valid():
            uploaded = form.cleaned_data["pdf_file"]
            title = form.cleaned_data.get("title") or None
            tags = form.cleaned_data.get("tags") or []
            stem = Path(uploaded.name).stem
            tmp_dir = tempfile.mkdtemp()
            tmp_path = Path(tmp_dir) / f"{stem}.pdf"
            doc = None
            try:
                with open(tmp_path, "wb") as fh:
                    for chunk in uploaded.chunks():
                        fh.write(chunk)
                from grime.pipeline.ingest import ingest_pdf
                doc, _, _ = ingest_pdf(tmp_path, title=title)
            except Exception as exc:
                upload_error = str(exc)
            finally:
                tmp_path.unlink(missing_ok=True)
                os.rmdir(tmp_dir)
            if doc is not None:
                if tags:
                    doc.tags = tags
                    doc.save(update_fields=["tags"])
                return redirect("grime:document", doc_pk=doc.pk)
        return render(request, self.template_name, self._build_context(form=form, upload_error=upload_error))

    def _build_context(self, form=None, upload_error=None):
        from grime.forms import CreateJobForm
        entity_counts = {
            row["page__document_id"]: row["n"]
            for row in Word.objects.filter(ner_label__startswith="B-")
            .values("page__document_id")
            .annotate(n=Count("pk"))
        }
        doc_list = [
            {
                "doc": doc,
                "doc_tags_json": json.dumps(doc.tags),
                "entity_count": entity_counts.get(doc.pk, 0),
            }
            for doc in Document.objects.annotate(page_count=Count("pages")).order_by("title")
        ]
        return {
            "doc_list": doc_list,
            "form": form if form is not None else DocumentUploadForm(),
            "upload_error": upload_error,
            "worker_slots": list(WorkerSlot.objects.all()),
            "job_form": CreateJobForm(),
        }


# ---------------------------------------------------------------------------
# Document page viewer
# ---------------------------------------------------------------------------


class DocumentPageView(StaffRequiredMixin, View):

    def get(self, request, doc_pk, page_pk=None):
        doc = get_object_or_404(Document, pk=doc_pk)
        pages = list(doc.pages.order_by("page_number"))

        if not pages:
            return render(request, "grime/document_detail.html", {"document": doc, "image_url": None})

        if page_pk is None:
            return redirect("grime:document_page", doc_pk=doc_pk, page_pk=pages[0].pk)

        page = get_object_or_404(DocumentPage, pk=page_pk, document=doc)
        page_pks = [p.pk for p in pages]
        idx = page_pks.index(page.pk)

        def _page_url(pk):
            return reverse("grime:document_page", args=[doc_pk, pk])

        prev_pk = page_pks[idx - 1] if idx > 0 else None
        next_pk = page_pks[idx + 1] if idx < len(page_pks) - 1 else None

        ctx = build_viewer_context(page)
        ctx.update({
            "document": doc,
            "prev_url": _page_url(prev_pk) if prev_pk else "",
            "next_url": _page_url(next_pk) if next_pk else "",
            "prev_url_json": _safe_json(_page_url(prev_pk) if prev_pk else None),
            "next_url_json": _safe_json(_page_url(next_pk) if next_pk else None),
            "page_list_json": _safe_json([
                {"pk": p.pk, "page_number": p.page_number, "url": _page_url(p.pk)}
                for p in pages
            ]),
            "page_position": idx + 1,
            "total_count": len(pages),
            "nav_prefix": "",
        })
        return render(request, "grime/document_detail.html", ctx)


# ---------------------------------------------------------------------------
# Document rename / delete
# ---------------------------------------------------------------------------


class RenameDocumentView(StaffRequiredMixin, View):
    http_method_names = ["post"]

    def post(self, request, doc_pk):
        doc = get_object_or_404(Document, pk=doc_pk)
        title = request.POST.get("title", "").strip()
        if not title:
            return JsonResponse({"error": "Title cannot be empty."}, status=400)
        doc.title = title
        update_fields = ["title"]
        raw_tags = request.POST.get("tags")
        if raw_tags is not None:
            try:
                parsed = json.loads(raw_tags)
                doc.tags = [str(t).strip() for t in parsed if str(t).strip()] if isinstance(parsed, list) else []
            except (json.JSONDecodeError, TypeError):
                doc.tags = []
            update_fields.append("tags")
        doc.save(update_fields=update_fields)
        return JsonResponse({"ok": True, "title": doc.title, "tags": doc.tags})


class DeleteDocumentView(StaffRequiredMixin, View):
    http_method_names = ["post"]

    def post(self, request, doc_pk):
        doc = get_object_or_404(Document, pk=doc_pk)
        doc.delete()
        return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# PDF export
# ---------------------------------------------------------------------------


class ExportDocumentPdfView(StaffRequiredMixin, View):
    """Download all pages of a document as a searchable sandwich PDF.

    Query params:
        confirmed_only=1  — include only words with a manual correction
    """

    def get(self, request, doc_pk):
        doc = get_object_or_404(Document, pk=doc_pk)
        confirmed_only = request.GET.get("confirmed_only") == "1"
        from grime.pipeline.export import export_document_pdf
        buf = io.BytesIO()
        export_document_pdf(doc, buf, confirmed_only=confirmed_only)
        buf.seek(0)
        slug = doc.title.replace(" ", "_")[:60]
        response = HttpResponse(buf, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{slug}.pdf"'
        return response


# ---------------------------------------------------------------------------
# Entity list
# ---------------------------------------------------------------------------


class EntityListView(StaffRequiredMixin, View):
    """List unique NER entities, optionally filtered to a single document via ?doc=<pk>."""

    def get(self, request):
        doc_pk = request.GET.get("doc")
        document = None
        if doc_pk:
            document = get_object_or_404(Document, pk=doc_pk)

        pages = (
            DocumentPage.objects
            .filter(words__ner_label__isnull=False)
            .distinct()
            .select_related("document")
            .prefetch_related("words")
        )
        if document:
            pages = pages.filter(document=document)

        agg = defaultdict(lambda: {"display_text": "", "doc_pks": set(), "count": 0})
        for page in pages:
            ordered = sorted(page.words.all(), key=lambda w: (w.line_num, w.word_num))
            for span in _build_entity_spans(ordered):
                key = (span["type"], span["text"].strip().lower())
                entry = agg[key]
                if not entry["display_text"]:
                    entry["display_text"] = span["text"]
                entry["doc_pks"].add(page.document_id)
                entry["count"] += 1

        entity_records = {(e.entity_type, e.text): e for e in Entity.objects.all()}

        entities = []
        for (etype, enorm), data in agg.items():
            rec = entity_records.get((etype, enorm))
            entities.append({
                "type": etype,
                "type_label": _ENTITY_TYPE_LABELS.get(etype, etype),
                "text": enorm,
                "display_text": data["display_text"],
                "doc_count": len(data["doc_pks"]),
                "occurrence_count": data["count"],
                "notes": rec.notes if rec else "",
                "dismissed": rec.dismissed if rec else False,
            })

        _TYPE_ORDER = {"PER": 0, "ORG": 1, "LOC": 2}
        entities.sort(key=lambda e: (_TYPE_ORDER.get(e["type"], 9), -e["occurrence_count"]))

        last_type = None
        for e in entities:
            e["show_type_header"] = e["type"] != last_type
            last_type = e["type"]

        return render(request, "grime/entity_list.html", {
            "entities": entities,
            "document": document,
            "entity_detail_url": reverse("grime:entity_detail"),
            "entity_dismiss_url": reverse("grime:entity_dismiss"),
            "csrf_token": request.META.get("CSRF_COOKIE", ""),
        })


# ---------------------------------------------------------------------------
# Entity detail
# ---------------------------------------------------------------------------


class EntityDetailView(StaffRequiredMixin, View):
    """Detail page for a single entity — all occurrences grouped by document."""

    def get(self, request):
        etype = request.GET.get("type", "").strip().upper()
        raw_text = request.GET.get("text", "").strip()
        if etype not in _VALID_ENTITY_TYPES or not raw_text:
            raise Http404

        enorm = raw_text.lower()
        entity = Entity.objects.filter(entity_type=etype, text=enorm).first()

        pages = (
            DocumentPage.objects
            .filter(words__ner_label__isnull=False)
            .distinct()
            .select_related("document")
            .prefetch_related("words")
        )

        doc_map = {}
        for page in pages:
            ordered = sorted(page.words.all(), key=lambda w: (w.line_num, w.word_num))
            occurrences = [
                s for s in _build_entity_spans(ordered)
                if s["type"] == etype and s["text"].strip().lower() == enorm
            ]
            if not occurrences:
                continue
            doc = page.document
            if doc.pk not in doc_map:
                doc_map[doc.pk] = {"document": doc, "page_map": {}}
            page_entry = doc_map[doc.pk]["page_map"]
            if page.pk not in page_entry:
                page_entry[page.pk] = {"page": page, "occurrences": []}
            image = page.display_image
            for occ in occurrences:
                page_entry[page.pk]["occurrences"].append({
                    "imageUrl": image.url if image else "",
                    "pageUrl": reverse("grime:document_page", args=[doc.pk, page.pk]),
                    **occ["bbox"],
                })

        docs_data = []
        for doc_entry in doc_map.values():
            pages_data = []
            total_occurrences = 0
            for page_entry in sorted(
                doc_entry["page_map"].values(),
                key=lambda p: p["page"].page_number or 0,
            ):
                pg = page_entry["page"]
                occs = page_entry["occurrences"]
                total_occurrences += len(occs)
                pages_data.append({
                    "pageNumber": pg.page_number,
                    "pageUrl": reverse("grime:document_page", args=[doc_entry["document"].pk, pg.pk]),
                    "occurrences": occs,
                })
            docs_data.append({
                "title": doc_entry["document"].title,
                "docUrl": doc_entry["document"].get_absolute_url(),
                "occurrenceCount": total_occurrences,
                "pages": pages_data,
            })
        docs_data.sort(key=lambda d: -d["occurrenceCount"])

        props = {
            "entityType": etype,
            "entityText": enorm,
            "displayText": raw_text,
            "typeLabel": _ENTITY_TYPE_LABELS.get(etype, etype),
            "notes": entity.notes if entity else "",
            "dismissed": entity.dismissed if entity else False,
            "docCount": len(doc_map),
            "noteUpdateUrl": reverse("grime:entity_note_update"),
            "dismissUrl": reverse("grime:entity_dismiss"),
            "csrfToken": request.META.get("CSRF_COOKIE", ""),
            "docs": docs_data,
        }

        return render(request, "grime/entity_detail.html", {
            "entity_type": etype,
            "type_label": _ENTITY_TYPE_LABELS.get(etype, etype),
            "display_text": raw_text,
            "entity_props_json": _safe_json(props),
        })


# ---------------------------------------------------------------------------
# Entity note / dismiss
# ---------------------------------------------------------------------------


class EntityNoteUpdateView(StaffRequiredMixin, View):
    """Save notes for an entity. Creates the Entity record if needed."""
    http_method_names = ["post"]

    def post(self, request):
        etype = (request.POST.get("type") or "").strip().upper()
        raw_text = (request.POST.get("text") or "").strip()
        notes = request.POST.get("notes") or ""
        if etype not in _VALID_ENTITY_TYPES or not raw_text:
            return JsonResponse({"error": "Invalid type or text"}, status=400)
        Entity.objects.update_or_create(
            entity_type=etype, text=raw_text.lower(),
            defaults={"notes": notes},
        )
        return JsonResponse({"ok": True})


class EntityDismissView(StaffRequiredMixin, View):
    """Toggle the dismissed flag for an entity."""
    http_method_names = ["post"]

    def post(self, request):
        etype = (request.POST.get("type") or "").strip().upper()
        raw_text = (request.POST.get("text") or "").strip()
        dismissed = request.POST.get("dismissed", "true").lower() not in ("false", "0", "")
        if etype not in _VALID_ENTITY_TYPES or not raw_text:
            return JsonResponse({"error": "Invalid type or text"}, status=400)
        entity, _ = Entity.objects.update_or_create(
            entity_type=etype, text=raw_text.lower(),
            defaults={"dismissed": dismissed},
        )
        return JsonResponse({"ok": True, "dismissed": entity.dismissed})
