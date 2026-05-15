"""
Grime data models.

The schema is six concrete tables:

    Document        — a standalone document (PDF, scanned booklet, ledger, etc.)
    DocumentPage    — one page or chunk of a Document; the OCR unit
    Word            — one OCR-extracted word on a DocumentPage, with bbox,
                      confidence, optional human correction, and optional NER label
    Tag             — a manually drawn region on a Document or DocumentPage, with
                      label and word-level subcomponents
    OCRPass         — audit record for one OCR run on a DocumentPage
    NERPass         — audit record for one NER run on a DocumentPage

Words hang off DocumentPage directly. OCRPass and NERPass are lightweight audit
logs of run parameters; they're not parents of Word.
"""

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.db import models

TEXT_SOURCE_CHOICES = [
    ("ocr", "OCR"),
    ("embedded", "Embedded"),
    ("manual", "Manual"),
]


class Document(models.Model):
    """
    A standalone archival document (PDF, scanned booklet, ledger, etc.).

    Large documents should be burst into DocumentPage chunks for OCR or
    structured extraction.
    """

    title = models.CharField(max_length=1000)
    document_id = models.CharField(max_length=100, blank=True)
    url = models.URLField(blank=True)
    text = models.TextField(blank=True)
    text_source = models.CharField(
        max_length=20,
        blank=True,
        choices=TEXT_SOURCE_CHOICES,
        help_text="How the text field was populated; set at ingest and not changed automatically",
    )
    manually_flagged = models.BooleanField(
        default=False,
        help_text="Manually flagged for follow-up",
    )
    notes = models.TextField(blank=True)
    file = models.FileField(upload_to="documents/", null=True, blank=True)

    class Meta:
        ordering = ["title"]

    def __str__(self):
        return self.title

    def get_absolute_url(self):
        return f"/documents/{self.id}"


class DocumentPage(models.Model):
    """
    A single page of a Document — the unit of OCR processing.

    ``file`` — the source PDF page (source of truth)
    ``image`` — PNG rendered from file at OCR time; populated by the
        ``pipeline.run_ocr`` orchestrator (or upstream by ``ingest``)
    """

    document = models.ForeignKey(
        Document, on_delete=models.CASCADE, related_name="pages"
    )
    page_number = models.PositiveIntegerField(null=True, blank=True)

    title = models.CharField(max_length=1000, blank=True)
    url = models.URLField(blank=True)
    text = models.TextField(blank=True)
    text_source = models.CharField(
        max_length=20, blank=True, choices=TEXT_SOURCE_CHOICES
    )
    manually_flagged = models.BooleanField(default=False)
    notes = models.TextField(blank=True)

    file = models.FileField(upload_to="documents/", null=True, blank=True)
    image = models.ImageField(upload_to="document_pages/", null=True, blank=True)

    class Meta:
        ordering = ["document", "page_number"]

    def __str__(self):
        if self.page_number is not None:
            return f"{self.document} — p. {self.page_number}"
        return f"{self.document} — {self.title or f'page {self.pk}'}"

    def extract_embedded_text(self) -> bool:
        """Extract the text layer from self.file (PDF) and save to self.text.

        Returns True if embedded text was found, False if the page has no text
        layer (caller should fall back to image rendering + OCR).
        """
        from pypdf import PdfReader

        if not self.file:
            return False
        text = PdfReader(self.file.path).pages[0].extract_text() or ""
        if not text.strip():
            return False
        self.text = text.strip()
        self.save(update_fields=["text"])
        return True


class OCRPass(models.Model):
    """
    Audit record for a single OCR run on a DocumentPage.

    Word rows hang off DocumentPage directly; OCRPass only records what method
    and parameters produced them.
    """

    STATUS_COMPLETE = "complete"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"
    STATUS_CHOICES = [
        (STATUS_COMPLETE, "Complete"),
        (STATUS_FAILED, "Failed"),
        (STATUS_SKIPPED, "Skipped"),
    ]

    page = models.ForeignKey(
        DocumentPage, on_delete=models.CASCADE, related_name="ocr_passes"
    )
    method = models.CharField(
        max_length=100, help_text="Tool used, e.g. 'tesseract', 'textract'"
    )
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default=STATUS_COMPLETE
    )
    confidence = models.FloatField(
        null=True, blank=True, help_text="Mean confidence for the page (0.0–100.0)"
    )
    output_text = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "OCR pass"
        verbose_name_plural = "OCR passes"

    def __str__(self):
        return f"OCR #{self.pk} ({self.method})"


class NERPass(models.Model):
    """
    Audit record for a single NER run on a DocumentPage.

    Word.ner_label values are updated in-place; NERPass records the schema,
    method, and parameters used.
    """

    STATUS_COMPLETE = "complete"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"
    STATUS_CHOICES = [
        (STATUS_COMPLETE, "Complete"),
        (STATUS_FAILED, "Failed"),
        (STATUS_SKIPPED, "Skipped"),
    ]

    page = models.ForeignKey(
        DocumentPage, on_delete=models.CASCADE, related_name="ner_passes"
    )
    schema_name = models.CharField(
        max_length=100,
        blank=True,
        help_text="Template or schema used (e.g. 'hf-historical-ner')",
    )
    method = models.CharField(max_length=100, blank=True)
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default=STATUS_COMPLETE
    )
    confidence = models.FloatField(null=True, blank=True)
    used_llm = models.BooleanField(default=False)
    llm_model = models.CharField(max_length=100, blank=True)
    threshold = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "NER pass"
        verbose_name_plural = "NER passes"

    def __str__(self):
        return f"NER #{self.pk} — {self.schema_name or self.method or 'unknown'}"


class Word(models.Model):
    """
    One OCR-extracted word on a DocumentPage.

    Bounding box coordinates are in the preprocessed image's coordinate space.
    Corrections are stored in-place: set ``corrected_text`` + ``corrected_ocr_by``
    + ``corrected_ocr_at``. Training data: ``ocr_text`` → ``corrected_text`` where not null.

    ``ner_label`` uses BIO encoding (B-PER, I-PER, B-LOC, I-LOC, B-ORG, I-ORG,
    or null for O / unlabelled). Populated by ``python manage.py ner``.
    """

    page = models.ForeignKey(
        DocumentPage, on_delete=models.CASCADE, related_name="words"
    )
    ocr_pass = models.ForeignKey(
        OCRPass,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="words",
        help_text="Which OCR run produced this word",
    )

    line_num = models.PositiveSmallIntegerField()
    word_num = models.PositiveSmallIntegerField()

    left = models.PositiveIntegerField()
    top = models.PositiveIntegerField()
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()

    conf = models.FloatField(help_text="Per-word confidence (0–100)")
    ocr_text = models.CharField(max_length=500)
    corrected_text = models.CharField(max_length=500, blank=True, null=True)
    is_ditto = models.BooleanField(default=False)
    corrected_ocr_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    corrected_ocr_at = models.DateTimeField(null=True, blank=True)

    ner_label = models.CharField(max_length=20, null=True, blank=True)
    corrected_label = models.CharField(max_length=20, null=True, blank=True)
    corrected_ner_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    corrected_ner_at = models.DateTimeField(null=True, blank=True)
    ner_pass = models.ForeignKey(
        NERPass,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="words",
        help_text="Which NER run produced ner_label",
    )

    class Meta:
        ordering = ["line_num", "word_num"]
        unique_together = [("page", "line_num", "word_num")]

    def __str__(self):
        return self.text

    @property
    def text(self) -> str:
        return self.corrected_text or self.ocr_text

    @property
    def label(self) -> str | None:
        return self.corrected_label or self.ner_label


class Tag(models.Model):
    """
    A manually drawn rectangle on a Document or DocumentPage image, with a label.

    ``subcomponents`` stores word-level sub-annotations within the region as a
    JSON list: ``[{word_id: int, label: str, text: str}, ...]``.

    ``created_by is None`` indicates an autogenerated tag (e.g. from match_tags).
    """

    source_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    source_id = models.PositiveIntegerField()
    source = GenericForeignKey("source_type", "source_id")
    label = models.CharField(max_length=200)
    bbox_left = models.PositiveIntegerField()
    bbox_top = models.PositiveIntegerField()
    bbox_width = models.PositiveIntegerField()
    bbox_height = models.PositiveIntegerField()
    subcomponents = models.JSONField(
        default=list,
        help_text="[{word_id, label, text}, ...] — word-level sub-annotations",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["source_type", "source_id"])]

    def __str__(self):
        return f"{self.label} ({self.source})"

    @property
    def autogenerated(self) -> bool:
        return self.created_by_id is None
