"""
Core ingest logic: PDF or directory → Document + DocumentPage records.

Called by the ``python manage.py ingest`` management command and the
in-app upload view.  The caller is responsible for logging and error
presentation; this module raises ``ValueError`` for invalid arguments.
"""

import io
from pathlib import Path

from django.conf import settings
from django.core.files.base import ContentFile
from pdf2image import convert_from_path

from grime.models import Document, DocumentPage, OCRPass, Word

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def ingest_pdf(
    pdf_path: Path,
    title: str | None = None,
    output_dir: Path | None = None,
    page_range_spec: str | None = None,
    force: bool = False,
    dry_run: bool = False,
    log=None,
) -> tuple:
    """Ingest a PDF into Document + DocumentPage records.

    Returns ``(document, pages_created, skipped)``.
    Raises ``ValueError`` for invalid arguments, ``ImportError`` if pdfplumber
    or pypdf are missing.
    """
    try:
        import pdfplumber
    except ImportError:
        raise ImportError("pdfplumber not installed; required for PDF ingest.")
    from pypdf import PdfReader, PdfWriter

    if log is None:
        log = lambda msg: None

    media_root = Path(settings.MEDIA_ROOT)
    stem = pdf_path.stem
    out_dir = output_dir or (media_root / "documents" / stem)

    reader = PdfReader(pdf_path)
    total = len(reader.pages)
    if page_range_spec:
        page_numbers = _parse_page_range(page_range_spec, total)
        if not page_numbers:
            raise ValueError(
                f"Page range {page_range_spec!r} matched no pages (PDF has {total})."
            )
    else:
        page_numbers = list(range(1, total + 1))

    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    if title is None:
        title = _title(stem)
    log(f"Document: {title!r}")

    probe_i = page_numbers[0]
    with pdfplumber.open(pdf_path) as plumb:
        has_embedded = bool(plumb.pages[probe_i - 1].extract_words())

    if not dry_run:
        doc, created = Document.objects.get_or_create(title=title)
        if not created and not force:
            log(
                f"  Document already exists (pk={doc.pk}); use force=True to replace pages."
            )
    else:
        doc = None

    log(f"\n  {len(page_numbers)} of {total} page(s) → {out_dir}\n")

    created_count = skipped = 0
    for i in page_numbers:
        page = reader.pages[i - 1]
        page_filename = f"{stem}_p{i:04d}.pdf"
        page_path = out_dir / page_filename
        rel_str = _rel(page_path, media_root)

        if DocumentPage.objects.filter(file=rel_str).exists():
            if not force:
                log(f"  skip  p.{i} (already exists)")
                skipped += 1
                continue
            if not dry_run:
                DocumentPage.objects.filter(file=rel_str).delete()

        if dry_run:
            log(f"  (dry) p.{i:04d} → {'embedded text' if has_embedded else 'OCR pending'}")
            created_count += 1
            continue

        writer = PdfWriter()
        writer.add_page(page)
        with open(page_path, "wb") as f:
            writer.write(f)

        if has_embedded:
            _ingest_embedded_page(doc, page_path, i, title, rel_str, stem, log=log)
        else:
            _ingest_image_only_page(doc, page_path, i, title, rel_str, stem, log=log)

        created_count += 1

    return doc, created_count, skipped


def ingest_directory(
    scan_dir: Path,
    force: bool = False,
    dry_run: bool = False,
    log=None,
) -> tuple:
    """Ingest every file in a directory as pages of a single Document.

    Returns ``(document, pages_created, skipped)``.
    """
    if log is None:
        log = lambda msg: None

    media_root = Path(settings.MEDIA_ROOT)
    files = sorted(p for p in scan_dir.iterdir() if p.is_file())
    if not files:
        log(f"  {scan_dir} contains no files.")
        return None, 0, 0

    title = _title(scan_dir.name)
    log(f"  {'(dry) ' if dry_run else ''}document  {title!r} ({len(files)} file(s))")

    if not dry_run:
        doc, doc_created = Document.objects.get_or_create(title=title)
    else:
        doc_created = not Document.objects.filter(title=title).exists()
        doc = None

    pages_created = skipped = 0
    for page_num, path in enumerate(files, 1):
        rel_str = _rel(path, media_root)

        if not doc_created and DocumentPage.objects.filter(file=rel_str).exists():
            if not force:
                log(f"  skip   {path.name} (DocumentPage already exists)")
                skipped += 1
                continue
            if not dry_run:
                DocumentPage.objects.filter(file=rel_str).delete()

        is_image = path.suffix.lower() in _IMAGE_EXTS
        log(f"  {'(dry) ' if dry_run else ''}page   p.{page_num:04d}  {path.name!r}")
        if not dry_run:
            is_pdf = path.suffix.lower() == ".pdf"
            dp = DocumentPage.objects.create(
                document=doc,
                page_number=page_num,
                title=f"{title} — p. {page_num}",
                file=rel_str,
                text_source="ocr" if (is_image or is_pdf) else "",
            )
            if is_image:
                _save_page_image(dp, path)
            elif is_pdf:
                _render_pdf_image(dp, path)
        pages_created += 1

    return doc, pages_created, skipped


# ---------------------------------------------------------------------------
# Page-level helpers
# ---------------------------------------------------------------------------


def _ingest_embedded_page(doc, page_path, i, title, rel_str, stem, log=None):
    if log is None:
        log = lambda msg: None
    dp = DocumentPage.objects.create(
        document=doc,
        page_number=i,
        title=f"{title} — p. {i}",
        file=rel_str,
        text_source="embedded",
    )
    dp.extract_embedded_text()
    log(f"  p.{i:04d} → embedded text")
    pil_pages = convert_from_path(str(page_path), dpi=150, first_page=1, last_page=1)
    buf = io.BytesIO()
    pil_pages[0].save(buf, format="PNG")
    dp.image.save(f"{stem}_p{i:04d}.png", ContentFile(buf.getvalue()), save=True)


def _ingest_image_only_page(doc, page_path, i, title, rel_str, stem, log=None):
    if log is None:
        log = lambda msg: None
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
    log(f"  p.{i:04d} → image rendered (OCR pending)")


def _ingest_structured_page(
    doc,
    page_path,
    i,
    title,
    rel_str,
    boundary_pt,
    page_width_pt,
    page_height_pt,
    stem,
    log=None,
):
    """Structured (two-column tabular) page: extract row text + bboxes from the text layer."""
    if log is None:
        log = lambda msg: None
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
    log(f"  p.{i:04d} → {row_count} row(s) ({len(line_ys)} lines)")
    buf = io.BytesIO()
    PILImage.fromarray(arr).save(buf, format="PNG")
    dp.image.save(f"{stem}_p{i:04d}.png", ContentFile(buf.getvalue()), save=True)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _parse_page_range(spec: str, total: int) -> list[int]:
    """Parse a print-dialog style page range (e.g. ``1-5,8,10``) into sorted page numbers."""
    pages: set[int] = set()
    for raw in spec.split(","):
        token = raw.strip()
        if not token:
            continue
        if "-" in token:
            lo_s, hi_s = token.split("-", 1)
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError as exc:
                raise ValueError(f"Invalid page range {token!r}") from exc
            if lo > hi:
                lo, hi = hi, lo
            pages.update(range(max(1, lo), min(total, hi) + 1))
        else:
            try:
                n = int(token)
            except ValueError as exc:
                raise ValueError(f"Invalid page number {token!r}") from exc
            if 1 <= n <= total:
                pages.add(n)
    return sorted(pages)


def _rel(path: Path, media_root: Path) -> str:
    try:
        return str(path.relative_to(media_root))
    except ValueError:
        return str(path)


def _title(stem: str) -> str:
    return stem.replace("_", " ").replace("-", " ").title()


def _render_pdf_image(dp: DocumentPage, pdf_path: Path) -> None:
    pil_pages = convert_from_path(str(pdf_path), dpi=300, first_page=1, last_page=1)
    buf = io.BytesIO()
    pil_pages[0].save(buf, format="PNG")
    dp.image.save(pdf_path.stem + ".png", ContentFile(buf.getvalue()), save=True)


def _save_page_image(dp: DocumentPage, img_path: Path) -> None:
    from PIL import Image as PILImage

    with PILImage.open(img_path) as img:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="PNG")
    dp.image.save(img_path.stem + ".png", ContentFile(buf.getvalue()), save=True)


# ---------------------------------------------------------------------------
# Structured-mode helpers
# ---------------------------------------------------------------------------


def _detect_name_boundary(words: list[dict], page_width: float) -> float:
    left_words = [w for w in words if w["x0"] < page_width / 2]
    if not left_words:
        return page_width / 4
    return max(w["x1"] for w in left_words) + 8.0


def _deskew_image(arr):
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
    if len(line_ys) < 2:
        return 0

    scale = dpi / 72.0
    name_boundary_px = round(boundary_pt * scale * 0.95)
    page_w_px = round(page_width_pt * scale)
    row_count = len(line_ys) - 1

    row_centers_pt = [
        ((line_ys[i] + line_ys[i + 1]) / 2) / scale for i in range(row_count)
    ]
    word_buckets: dict[int, list[dict]] = {}
    for w in col0_words:
        best = min(
            range(row_count), key=lambda i, top=w["top"]: abs(top - row_centers_pt[i])
        )
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
        name_text = " ".join(
            w["text"] for w in sorted(row_words, key=lambda w: w["x0"])
        )
        words.append(
            Word(
                page=dp,
                ocr_pass=ocr_pass,
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
