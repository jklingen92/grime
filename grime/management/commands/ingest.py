"""
Ingest a PDF or directory of files into Document + DocumentPage records.

PDF mode (single file)::

    python manage.py ingest colorado_ledger.pdf
    python manage.py ingest colorado_ledger.pdf --output media/documents/colorado_ledger/
    python manage.py ingest colorado_ledger.pdf --skip-pages 2
    python manage.py ingest colorado_ledger.pdf --dry-run

PDF mode splits the PDF into single-page PDFs, creates a parent Document plus
one DocumentPage per page, and (if the PDF has an embedded text layer)
extracts that text and renders a PNG image of the page.  If the PDF has no
text layer, only the page image is rendered — OCR is deferred to
``python manage.py ocr``.

Structured mode is offered interactively when an embedded text layer is
detected.  It creates one ``OCRPass`` + two ``Word`` rows per row in a
two-column tabular ledger (name | remainder).

Directory mode::

    python manage.py ingest media/documents/colorado_ledger/
    python manage.py ingest /path/to/scans/
    python manage.py ingest /path/to/scans/ --force

Files whose stem matches ``<parent>_pNNNN`` (e.g. ``ledger_p0001.pdf``,
``ledger_p0001.png``) are grouped as pages under a Document named after
``<parent>``.  Standalone image files in the directory become pages under a
Document named after the directory.  Any remaining standalone files (e.g.
loose PDFs) each become their own Document.
"""

import io
import re
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError
from pdf2image import convert_from_path

from grime.models import Document, DocumentPage, OCRPass, Word

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}

# Matches burst-chunk suffixes like _p0001 or _p001-020 produced by PDF bursting.
_CHUNK_RE = re.compile(r"^(.+?)_p(\d+)(?:-\d+)?$")


class Command(BaseCommand):
    help = (
        "Ingest a PDF or directory into Document + DocumentPage records.\n\n"
        "  ingest <pdf>        — split a PDF into pages\n"
        "  ingest <directory>  — group files in a directory; _p0001 suffix → pages"
    )

    def add_arguments(self, parser):
        parser.add_argument("path", help="PDF file or directory to ingest")
        parser.add_argument("--dry-run", action="store_true", help="Report without writing")
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-create records for files already in the DB",
        )
        parser.add_argument(
            "--output",
            default=None,
            help="Output directory for split pages (PDF mode only; "
            "default: MEDIA_ROOT/documents/<stem>/)",
        )
        parser.add_argument(
            "--skip-pages",
            type=int,
            default=0,
            metavar="N",
            help="Skip the first N pages of the PDF (e.g. cover pages, table of contents)",
        )

    def handle(self, *args, **options):
        target = Path(options["path"])
        if not target.exists():
            raise CommandError(f"Path not found: {target}")

        if target.is_file():
            if target.suffix.lower() != ".pdf":
                raise CommandError("Single-file mode only supports PDFs.")
            self._ingest_pdf(target, options)
        else:
            self._ingest_directory(target, options)

    # ── PDF mode ────────────────────────────────────────────────────────────

    def _ingest_pdf(self, pdf_path, options):
        try:
            import pdfplumber
        except ImportError:
            raise CommandError("pdfplumber not installed; required for PDF ingest.")
        from pypdf import PdfReader, PdfWriter

        media_root = Path(settings.MEDIA_ROOT)
        stem = pdf_path.stem
        out_dir = (
            Path(options["output"]) if options["output"] else media_root / "documents" / stem
        )
        dry_run = options["dry_run"]
        force = options["force"]
        skip_pages = options["skip_pages"]

        if not dry_run:
            out_dir.mkdir(parents=True, exist_ok=True)

        title = _title(stem)
        self.stdout.write(f"Document: {title!r}")

        # Probe the first non-skipped page for embedded text + structure
        with pdfplumber.open(pdf_path) as plumb:
            if skip_pages >= len(plumb.pages):
                raise CommandError(
                    f"--skip-pages {skip_pages} >= total pages ({len(plumb.pages)})"
                )
            probe_page = plumb.pages[skip_pages]
            probe_words = probe_page.extract_words()
            page_width_pt = probe_page.width
            page_height_pt = probe_page.height
            has_embedded = bool(probe_words)

        # ── Interactive: structured mode? ─────────────────────────────────
        is_structured = False
        column_schema = None
        boundary_pt = None

        if has_embedded:
            self.stdout.write("\n  Embedded text detected.")
            answer = input("  Is this structured/tabular data? [y/N] ").strip().lower()
            is_structured = answer == "y"

            if is_structured:
                suggested = _detect_name_boundary(probe_words, page_width_pt)
                self.stdout.write(f"  Detected name column boundary: {suggested:.1f} pts")
                raw = input(f"  Enter boundary in pts [Enter = {suggested:.1f}]: ").strip()
                if raw:
                    try:
                        boundary_pt = float(raw)
                    except ValueError:
                        self.stderr.write("  Invalid — using detected boundary.")
                        boundary_pt = suggested
                else:
                    boundary_pt = suggested
                column_schema = {"col_boundary_pt": boundary_pt}
                self.stdout.write(f"  Name/remainder split at {boundary_pt:.1f} pts.")

        # ── Create / update parent Document ───────────────────────────────
        if not dry_run:
            doc, created = Document.objects.get_or_create(
                title=title,
                defaults={
                    "is_structured": is_structured,
                    "column_schema": column_schema,
                },
            )
            if not created and force:
                doc.is_structured = is_structured
                doc.column_schema = column_schema
                doc.save(update_fields=["is_structured", "column_schema"])
            elif not created:
                self.stdout.write(
                    f"  Document already exists (pk={doc.pk}); use --force to replace pages."
                )
        else:
            doc = None

        reader = PdfReader(pdf_path)
        total = len(reader.pages)
        if skip_pages:
            self.stdout.write(
                f"\n  {total} page(s), skipping first {skip_pages} → {out_dir}\n"
            )
        else:
            self.stdout.write(f"\n  {total} page(s) → {out_dir}\n")

        created_count = skipped = 0
        for i, page in enumerate(reader.pages, 1):
            if i <= skip_pages:
                continue
            page_filename = f"{stem}_p{i:04d}.pdf"
            page_path = out_dir / page_filename
            rel_str = _rel(page_path, media_root)

            if DocumentPage.objects.filter(file=rel_str).exists():
                if not force:
                    self.stdout.write(f"  skip  p.{i} (already exists)")
                    skipped += 1
                    continue
                if not dry_run:
                    DocumentPage.objects.filter(file=rel_str).delete()

            if dry_run:
                if has_embedded and is_structured:
                    self.stdout.write(f"  (dry) p.{i:04d} → structured/embedded")
                elif has_embedded:
                    self.stdout.write(f"  (dry) p.{i:04d} → embedded text")
                else:
                    self.stdout.write(f"  (dry) p.{i:04d} → OCR pending")
                created_count += 1
                continue

            writer = PdfWriter()
            writer.add_page(page)
            with open(page_path, "wb") as f:
                writer.write(f)

            if has_embedded and is_structured:
                self._ingest_structured_page(
                    doc,
                    page_path,
                    i,
                    title,
                    rel_str,
                    boundary_pt,
                    page_width_pt,
                    page_height_pt,
                    stem,
                )
            elif has_embedded:
                self._ingest_embedded_page(doc, page_path, i, title, rel_str, stem)
            else:
                self._ingest_image_only_page(doc, page_path, i, title, rel_str, stem)

            created_count += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'Would create' if dry_run else 'Created'} {created_count} page(s); "
                f"skipped {skipped}."
            )
        )

    def _ingest_embedded_page(self, doc, page_path, i, title, rel_str, stem):
        """A page with an embedded text layer: extract text + render a preview image."""
        dp = DocumentPage.objects.create(
            document=doc,
            page_number=i,
            title=f"{title} — p. {i}",
            file=rel_str,
            text_source="embedded",
        )
        dp.extract_embedded_text()
        self.stdout.write(f"  p.{i:04d} → embedded text")
        pil_pages = convert_from_path(str(page_path), dpi=150, first_page=1, last_page=1)
        buf = io.BytesIO()
        pil_pages[0].save(buf, format="PNG")
        dp.image.save(f"{stem}_p{i:04d}.png", ContentFile(buf.getvalue()), save=True)

    def _ingest_image_only_page(self, doc, page_path, i, title, rel_str, stem):
        """A page with no text layer: render image only; OCR runs separately."""
        pil_pages = convert_from_path(str(page_path), dpi=300, first_page=1, last_page=1)
        buf = io.BytesIO()
        pil_pages[0].save(buf, format="PNG")
        dp = DocumentPage.objects.create(
            document=doc,
            page_number=i,
            title=f"{title} — p. {i}",
            file=rel_str,
            text_source="ocr",
        )
        dp.image.save(f"{stem}_p{i:04d}.png", ContentFile(buf.getvalue()), save=True)
        self.stdout.write(f"  p.{i:04d} → image rendered (OCR pending)")

    def _ingest_structured_page(
        self,
        doc,
        page_path,
        i,
        title,
        rel_str,
        boundary_pt,
        page_width_pt,
        page_height_pt,
        stem,
    ):
        """A structured (two-column tabular) page: extract row text + bboxes from the text layer.

        Known limitation: pdfplumber text-layer coordinates don't always
        align with the scanned image pixels for documents that were scanned
        page-by-page at slightly different angles. The text content is
        usually correct but the Word bboxes may sit a few pixels off the
        underlying glyphs in the admin viewer.
        """
        import cv2
        import numpy as np
        import pdfplumber
        from PIL import Image as PILImage

        with pdfplumber.open(page_path) as plumb_page:
            page_words = plumb_page.pages[0].extract_words()
        col0_words = sorted(
            (w for w in page_words if w["x0"] < boundary_pt),
            key=lambda w: w["top"],
        )
        pil_pages = convert_from_path(str(page_path), dpi=200, first_page=1, last_page=1)
        arr, _ = _deskew_image(np.array(pil_pages[0]))
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        line_ys = _detect_row_lines(gray)
        dp = DocumentPage.objects.create(
            document=doc,
            page_number=i,
            title=f"{title} — p. {i}",
            file=rel_str,
            text_source="embedded",
        )
        row_count = _create_structured_words(
            dp, line_ys, col0_words, boundary_pt, page_width_pt, page_height_pt
        )
        self.stdout.write(f"  p.{i:04d} → {row_count} row(s) ({len(line_ys)} lines)")
        buf = io.BytesIO()
        PILImage.fromarray(arr).save(buf, format="PNG")
        dp.image.save(f"{stem}_p{i:04d}.png", ContentFile(buf.getvalue()), save=True)

    # ── Directory mode ───────────────────────────────────────────────────────

    def _ingest_directory(self, scan_dir, options):
        media_root = Path(settings.MEDIA_ROOT)
        dry_run = options["dry_run"]
        force = options["force"]

        chunks: dict[str, list[tuple[int, Path]]] = {}
        standalones: list[Path] = []
        image_standalones: list[Path] = []

        for path in sorted(scan_dir.iterdir()):
            if not path.is_file():
                continue
            m = _CHUNK_RE.match(path.stem)
            if m:
                parent_stem, page_str = m.group(1), m.group(2)
                chunks.setdefault(parent_stem, []).append((int(page_str), path))
            elif path.suffix.lower() in _IMAGE_EXTS:
                image_standalones.append(path)
            else:
                standalones.append(path)

        docs_created = pages_created = skipped = 0

        # Non-image standalones → individual Documents.
        for path in standalones:
            if path.stem in chunks:
                continue
            rel_str = _rel(path, media_root)
            title = _title(path.stem)

            if Document.objects.filter(file=rel_str).exists():
                if not force:
                    self.stdout.write(f"  skip   {path.name} (Document already exists)")
                    skipped += 1
                    continue
                if not dry_run:
                    Document.objects.filter(file=rel_str).delete()

            self.stdout.write(
                f"  {'(dry) ' if dry_run else ''}document  {path.name!r} → {title!r}"
            )
            if not dry_run:
                Document.objects.create(title=title, file=rel_str)
            docs_created += 1

        # Image standalones → pages under a Document named for the directory.
        if image_standalones:
            dir_title = _title(scan_dir.name)
            self.stdout.write(
                f"  {'(dry) ' if dry_run else ''}document  (image folder) {dir_title!r}"
            )

            if not dry_run:
                doc, doc_created = Document.objects.get_or_create(title=dir_title)
            else:
                doc_created = not Document.objects.filter(title=dir_title).exists()
                doc = None

            if doc_created:
                docs_created += 1

            for page_num, path in enumerate(image_standalones, 1):
                rel_str = _rel(path, media_root)

                if not doc_created and DocumentPage.objects.filter(file=rel_str).exists():
                    if not force:
                        self.stdout.write(f"  skip   {path.name} (DocumentPage already exists)")
                        skipped += 1
                        continue
                    if not dry_run:
                        DocumentPage.objects.filter(file=rel_str).delete()

                self.stdout.write(
                    f"  {'(dry) ' if dry_run else ''}page      {path.name!r} → p.{page_num}"
                )
                if not dry_run:
                    dp = DocumentPage.objects.create(
                        document=doc,
                        page_number=page_num,
                        title=f"{dir_title} — p. {page_num}",
                        file=rel_str,
                        text_source="ocr",
                    )
                    _save_page_image(dp, path)
                pages_created += 1

        # _pNNNN-suffixed chunks → pages under a Document named for the parent stem.
        for parent_stem, chunk_list in sorted(chunks.items()):
            parent_title = _title(parent_stem)

            if not dry_run:
                doc, doc_created = Document.objects.get_or_create(title=parent_title)
            else:
                doc_created = not Document.objects.filter(title=parent_title).exists()
                doc = None

            if doc_created:
                self.stdout.write(
                    f"  {'(dry) ' if dry_run else ''}document  (parent) {parent_title!r}"
                )
                docs_created += 1

            for page_num, path in sorted(chunk_list):
                rel_str = _rel(path, media_root)

                if not doc_created and DocumentPage.objects.filter(file=rel_str).exists():
                    if not force:
                        self.stdout.write(
                            f"  skip   {path.name} (DocumentPage already exists)"
                        )
                        skipped += 1
                        continue
                    if not dry_run:
                        DocumentPage.objects.filter(file=rel_str).delete()

                self.stdout.write(
                    f"  {'(dry) ' if dry_run else ''}page      {path.name!r} → p.{page_num}"
                )
                if not dry_run:
                    dp = DocumentPage.objects.create(
                        document=doc,
                        page_number=page_num,
                        title=f"{parent_title} — p. {page_num}",
                        file=rel_str,
                    )
                    if path.suffix.lower() in _IMAGE_EXTS:
                        _save_page_image(dp, path)
                pages_created += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'Would create' if dry_run else 'Created'} "
                f"{docs_created} document(s), {pages_created} page(s); skipped {skipped}."
            )
        )


def _rel(path: Path, media_root: Path) -> str:
    try:
        return str(path.relative_to(media_root))
    except ValueError:
        return str(path)


def _title(stem: str) -> str:
    return stem.replace("_", " ").replace("-", " ").title()


def _save_page_image(dp: DocumentPage, img_path: Path) -> None:
    """Save an image file to dp.image as PNG (converting if necessary)."""
    from PIL import Image as PILImage

    with PILImage.open(img_path) as img:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="PNG")
    dp.image.save(img_path.stem + ".png", ContentFile(buf.getvalue()), save=True)


def _detect_name_boundary(words: list[dict], page_width: float) -> float:
    """Estimate where the name column ends: rightmost x1 of words in the left half + margin."""
    left_words = [w for w in words if w["x0"] < page_width / 2]
    if not left_words:
        return page_width / 4
    return max(w["x1"] for w in left_words) + 8.0


def _deskew_image(arr):
    """Deskew a rendered page image array. Returns (corrected_array, angle_applied)."""
    import cv2

    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY) if arr.ndim == 3 else arr
    angle = _detect_skew(gray)
    if abs(angle) <= 0.1:
        return arr, 0.0
    h, w = gray.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
    corrected = cv2.warpAffine(
        arr, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
    return corrected, angle


def _detect_skew(gray) -> float:
    """Detect scan skew from horizontal ruled lines. Returns degrees to rotate to correct."""
    import cv2
    import numpy as np

    h, w = gray.shape
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 8, 1))
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 2
    )
    horiz = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(horiz, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    angles = []
    for c in contours:
        if cv2.contourArea(c) < 50:
            continue
        _, _, angle = cv2.minAreaRect(c)
        if angle < -45:
            angle += 90
        angles.append(angle)
    if not angles:
        return 0.0
    return float(np.median(angles))


def _detect_row_lines(gray) -> list[int]:
    """Detect horizontal ruled lines in a grayscale page image; return y pixel centres."""
    import cv2

    h, w = gray.shape
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 6, 1))
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 2
    )
    horiz = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
    proj = horiz.sum(axis=1)

    threshold = proj.max() * 0.3
    in_line = False
    line_start = 0
    raw = []
    for y, v in enumerate(proj):
        if v > threshold and not in_line:
            in_line = True
            line_start = y
        elif v <= threshold and in_line:
            in_line = False
            raw.append((line_start + y) // 2)

    merged: list[int] = []
    for y in raw:
        if merged and y - merged[-1] < 5:
            merged[-1] = (merged[-1] + y) // 2
        else:
            merged.append(y)
    return merged


def _create_structured_words(
    dp: DocumentPage,
    line_ys: list[int],
    col0_words: list[dict],
    boundary_pt: float,
    page_width_pt: float,
    page_height_pt: float,
    dpi: int = 200,
) -> int:
    """Create an OCRPass + two Word rows per populated row.

    Row boundaries come from image-detected horizontal lines, so they are
    accurate regardless of any scan-to-text-layer misalignment.  Name text
    is assigned from the text-layer col-0 words by closest-centre matching.
    Returns the number of rows created.
    """
    if len(line_ys) < 2:
        return 0

    scale = dpi / 72.0
    name_boundary_px = round(boundary_pt * scale * 0.95)
    page_w_px = round(page_width_pt * scale)
    row_count = len(line_ys) - 1

    row_centers_pt = [((line_ys[i] + line_ys[i + 1]) / 2) / scale for i in range(row_count)]
    word_buckets: dict[int, list[dict]] = {}
    for w in col0_words:
        best = min(range(row_count), key=lambda i, top=w["top"]: abs(top - row_centers_pt[i]))
        word_buckets.setdefault(best, []).append(w)

    ocr_pass = OCRPass.objects.create(
        page=dp,
        method="structured",
        status=OCRPass.STATUS_COMPLETE,
        confidence=1.0,
    )

    words = []
    line_num = 0
    for row_i in range(row_count):
        row_words = word_buckets.get(row_i, [])
        if not row_words:
            continue
        top_px = line_ys[row_i]
        bottom_px = line_ys[row_i + 1]
        row_h_px = max(1, bottom_px - top_px)
        name_text = " ".join(w["text"] for w in sorted(row_words, key=lambda w: w["x0"]))

        words.append(
            Word(
                page=dp,
                ocr_pass=ocr_pass,
                block_num=0,
                par_num=0,
                line_num=line_num,
                word_num=0,
                left=0,
                top=top_px,
                width=name_boundary_px,
                height=row_h_px,
                conf=100.0,
                text=name_text,
            )
        )
        words.append(
            Word(
                page=dp,
                ocr_pass=ocr_pass,
                block_num=0,
                par_num=0,
                line_num=line_num,
                word_num=1,
                left=name_boundary_px,
                top=top_px,
                width=page_w_px - name_boundary_px,
                height=row_h_px,
                conf=0.0,
                text="",
            )
        )
        line_num += 1

    Word.objects.bulk_create(words)
    return line_num
