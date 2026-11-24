"""
Export DocumentPages as static data for the browser-only demo.

Per page, writes ``pages/<pk>/page.json`` (the data half of the viewer's
VIEWER_CONFIG) plus the page's original image. Also writes
``manifest.json``: the dashboard rows for the pages' documents, one per page.
``npm run build:demo`` bundles the output directory into ``dist-demo/``.
Read-only: nothing in the database changes.

Examples::

    python manage.py export_demo --page 123
    python manage.py export_demo --page 12 --page 40 --page 77 --out demo-data/
"""

import json
import shutil
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from grime.models import Document, DocumentPage
from grime.viewer import build_document_list, build_viewer_context


class Command(BaseCommand):
    help = "Export pages' viewer data and images, plus a dashboard manifest, for the static demo."

    def add_arguments(self, parser):
        parser.add_argument(
            "--page",
            type=int,
            action="append",
            required=True,
            metavar="PK",
            help="DocumentPage pk (repeatable)",
        )
        parser.add_argument(
            "--out",
            default="demo-data",
            metavar="DIR",
            help="Output directory (default: demo-data)",
        )

    def handle(self, *args, page, out, **options):
        pages = {
            p.pk: p
            for p in DocumentPage.objects.filter(pk__in=page).select_related("document")
        }
        missing = [pk for pk in page if pk not in pages]
        if missing:
            raise CommandError(
                f"DocumentPage(s) not found: {', '.join(map(str, missing))}"
            )
        # The dashboard links each document to one page; two pages of one document would collide.
        by_doc = {}
        for p in pages.values():
            if p.document_id in by_doc:
                raise CommandError(
                    f"Pages {by_doc[p.document_id]} and {p.pk} are from the same document"
                )
            by_doc[p.document_id] = p.pk

        out_dir = Path(out)
        # Clear old pages so the build never ships a page the manifest doesn't list.
        shutil.rmtree(out_dir / "pages", ignore_errors=True)
        for page_obj in pages.values():
            n_words, n_ann = _export_page(
                page_obj, out_dir / "pages" / str(page_obj.pk)
            )
            self.stdout.write(
                f"Exported page {page_obj.pk}: {n_words} words, {n_ann} annotations"
            )

        # Same rows the real dashboard renders, so the demo list can't drift from it.
        manifest = [
            {
                "pagePk": by_doc[entry["doc"].pk],
                "docPk": entry["doc"].pk,
                "title": entry["doc"].title,
                "tags": entry["doc"].tags or [],
                "pageCount": entry["doc"].page_count,
                "entityCount": entry["entity_count"],
            }
            for entry in build_document_list(Document.objects.filter(pk__in=by_doc))
        ]
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
        self.stdout.write(
            self.style.SUCCESS(f"Wrote {len(manifest)} documents -> {out_dir}/")
        )


def _export_page(page_obj: DocumentPage, out_dir: Path) -> tuple[int, int]:
    """Write one page's page.json and images into out_dir; returns (word count, annotation count)."""
    # Same context the real template gets, so the demo can't drift from it.
    ctx = build_viewer_context(page_obj)
    if ctx["image_url"] is None:
        raise CommandError(f"DocumentPage {page_obj.pk} has no image")

    out_dir.mkdir(parents=True, exist_ok=True)
    # Original only: the demo re-applies saved adjustments as a live preview
    # instead of showing the baked corrected image.
    original_name = _copy_image(
        page_obj.image or page_obj.display_image, out_dir, "original"
    )

    data = {
        "pagePk": page_obj.pk,
        "documentTitle": page_obj.document.title,
        "originalImageUrl": original_name,
        "imageHasCorrected": ctx["image_has_corrected"],
        "imageAdjustments": json.loads(ctx["image_adjustments_json"]),
        "imageAlt": ctx["image_alt"],
        "ocrWords": json.loads(ctx["ocr_words_json"]),
        "annotations": json.loads(ctx["annotations_json"]),
        "citations": json.loads(ctx["citations_json"]),
        "nerModels": json.loads(ctx["ner_models_json"]),
        "confirmedWordCount": ctx["confirmed_word_count"],
        "docAnnotationCount": ctx["doc_annotation_count"],
    }
    (out_dir / "page.json").write_text(json.dumps(data, indent=1))
    return len(data["ocrWords"]), len(data["annotations"])


def _copy_image(field, out_dir: Path, stem: str) -> str:
    """Copy an ImageField's file to out_dir/<stem><ext> via storage (works for local or S3)."""
    name = stem + Path(field.name).suffix.lower()
    with field.open("rb") as src:
        (out_dir / name).write_bytes(src.read())
    return name
