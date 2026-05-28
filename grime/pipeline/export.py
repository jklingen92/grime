"""
Export a Document (or subset of pages) as a searchable sandwich PDF.

Each page is rendered as:
  - visible layer: the page's display_image (corrected_image if present, else image)
  - invisible text layer: Word bounding boxes from the database, positioned to
    match the image, using PDF text rendering mode 3 (invisible)

The invisible text layer makes the PDF searchable and allows copy/paste without
altering the visual appearance of the scanned image.

Coordinate system notes:
  - Word bboxes are stored as pixel coordinates in the rendered PNG
  - PDF uses points (1 pt = 1/72 inch), origin at bottom-left
  - Scale is derived from the ratio of PDF page dimensions to PNG pixel dimensions
  - Y-axis is flipped: pdf_y = page_height_pts - (word.top + word.height) * scale_y
"""

import io
from pathlib import Path

from PIL import Image
from pypdf import PdfReader
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from grime.models import Document, DocumentPage, Word


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_FALLBACK_PAGE_SIZE = (8.5 * inch, 11 * inch)  # letter in points


def _page_size_pts(page: DocumentPage) -> tuple[float, float]:
    """Return (width_pts, height_pts) for the page.

    Reads from the source PDF if available; falls back to letter size.
    """
    if page.file:
        try:
            reader = PdfReader(page.file.path)
            pdf_page = reader.pages[0]
            w = float(pdf_page.mediabox.width)
            h = float(pdf_page.mediabox.height)
            if w > 0 and h > 0:
                return w, h
        except Exception:
            pass

    # Fall back: infer from image DPI metadata
    if page.display_image:
        try:
            img = Image.open(page.display_image.path)
            dpi = img.info.get("dpi")
            if dpi:
                dpi_x, dpi_y = dpi
                w_pts = img.width / dpi_x * 72
                h_pts = img.height / dpi_y * 72
                if w_pts > 0 and h_pts > 0:
                    return w_pts, h_pts
        except Exception:
            pass

    return _FALLBACK_PAGE_SIZE


def _render_page(c: canvas.Canvas, page: DocumentPage, confirmed_only: bool) -> None:
    """Draw one page onto the reportlab Canvas."""
    img_field = page.display_image
    if not img_field:
        c.showPage()
        return

    img_path = img_field.path
    page_w_pts, page_h_pts = _page_size_pts(page)
    c.setPageSize((page_w_pts, page_h_pts))

    # Draw the scanned image as the visible background.
    c.drawImage(img_path, 0, 0, width=page_w_pts, height=page_h_pts)

    # Compute scale from PNG pixels → PDF points.
    with Image.open(img_path) as img:
        img_w_px, img_h_px = img.size

    if img_w_px == 0 or img_h_px == 0:
        c.showPage()
        return

    scale_x = page_w_pts / img_w_px
    scale_y = page_h_pts / img_h_px

    # Draw invisible text layer.
    # setTextRenderMode(3) lives on PDFTextObject, not on Canvas directly.
    words_qs = page.words.order_by("line_num", "word_num")
    if confirmed_only:
        words_qs = words_qs.filter(corrected_text__isnull=False)

    for word in words_qs:
        text = word.text
        if not text or not text.strip():
            continue

        # Word height in points drives font size.
        font_size = max(1.0, word.height * scale_y)

        # PDF origin is bottom-left; PNG origin is top-left.
        x = word.left * scale_x
        y = page_h_pts - (word.top + word.height) * scale_y

        text_obj = c.beginText(x, y)
        text_obj.setFont("Helvetica", font_size)
        text_obj.setTextRenderMode(3)  # invisible: no fill, no stroke
        text_obj.textOut(text)
        c.drawText(text_obj)

    c.showPage()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def export_document_pdf(
    document: Document,
    output: "str | Path | io.BytesIO",
    confirmed_only: bool = False,
    page_pks: "list[int] | None" = None,
) -> None:
    """Write a searchable sandwich PDF for *document* to *output*.

    Args:
        document: The Document instance to export.
        output: File path (str or Path) or a BytesIO buffer to write to.
        confirmed_only: When True, only include words where corrected_text is
            set (i.e. manually verified). When False (default), use word.text
            which returns corrected_text if available, otherwise ocr_text.
        page_pks: Optional list of DocumentPage PKs to include. If None, all
            pages are included in page_number order.
    """
    pages_qs = document.pages.order_by("page_number")
    if page_pks is not None:
        pages_qs = pages_qs.filter(pk__in=page_pks)
    pages = list(pages_qs)

    c = canvas.Canvas(str(output) if not isinstance(output, io.BytesIO) else output)

    for page in pages:
        _render_page(c, page, confirmed_only)

    c.save()
