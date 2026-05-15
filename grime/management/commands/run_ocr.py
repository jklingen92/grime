"""
Run OCR on a Document's pages.

Examples::

    python manage.py run_ocr --document 42                       # Textract → Tesseract fallback
    python manage.py run_ocr --document 42 --page 5              # one page
    python manage.py run_ocr --document 42 --engine tesseract    # force Tesseract
    python manage.py run_ocr --document 42 --engine textract     # force Textract (no fallback)
    python manage.py run_ocr --document 42 --force               # replace existing OCRPass + Words
    python manage.py run_ocr --document 42 --dry-run
"""

from django.core.management.base import BaseCommand, CommandError

from grime.models import Document, OCRPass, Word


class Command(BaseCommand):
    help = "Run OCR (Textract or Tesseract) on a document's pages."

    def add_arguments(self, parser):
        parser.add_argument(
            "--document",
            required=True,
            metavar="ID",
            help="Document pk or document_id",
        )
        parser.add_argument(
            "--page",
            type=int,
            metavar="N",
            help="Restrict to a single page_number",
        )
        parser.add_argument(
            "--engine",
            choices=["textract", "tesseract"],
            default=None,
            help="Force a specific engine. Default: Textract with Tesseract fallback.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be processed without writing to the database",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Replace existing OCRPass + Word rows; prompts if human-corrected words would be lost",
        )

    def handle(self, **options):
        self.dry_run = options["dry_run"]
        self.force = options["force"]
        self.engine = options["engine"]

        doc = self._resolve_document(options["document"])
        pages_qs = doc.pages.order_by("page_number")
        if options["page"] is not None:
            pages_qs = pages_qs.filter(page_number=options["page"])
        pages = list(pages_qs)
        if not pages:
            raise CommandError(f"Document '{doc}' has no pages to process.")
        self._run_pages(pages, label=str(doc))

    def _resolve_document(self, id_arg: str) -> Document:
        doc = None
        if id_arg.isdigit():
            doc = Document.objects.filter(pk=int(id_arg)).first()
        if doc is None:
            doc = Document.objects.filter(document_id=id_arg).first()
        if doc is None:
            raise CommandError(f"Document '{id_arg}' not found.")
        return doc

    def _should_skip(self, page) -> tuple[bool, str]:
        if self.force:
            return False, ""
        if OCRPass.objects.filter(page=page).exists():
            return True, "skipped (existing OCRPass; use --force to replace)"
        return False, ""

    def _run_pages(self, pages, label):
        from grime.pipeline.ocr import run_page

        self.stdout.write(f"{label} — {len(pages)} page(s) to process")

        if not self._confirm_force(pages):
            return

        processed = skipped = 0
        for i, page in enumerate(pages, 1):
            page_label = (
                f"p.{page.page_number:04d}"
                if page.page_number is not None
                else str(page)
            )
            self.stdout.write(f"  [{i}/{len(pages)}] {page_label}")

            skip, reason = self._should_skip(page)
            if skip:
                self.stdout.write(f"    {reason}")
                skipped += 1
                continue

            if self.dry_run:
                self.stdout.write("    (dry-run)")
                processed += 1
                continue

            try:
                if self.force:
                    Word.objects.filter(page=page).delete()
                    OCRPass.objects.filter(page=page).delete()
                    page.text_complete = False
                ocr_pass = run_page(page, engine=self.engine, force=self.force)
                if ocr_pass is None:
                    self.stdout.write(
                        self.style.WARNING(
                            "    skipped (no image or already complete)"
                        )
                    )
                else:
                    self.stdout.write(self.style.SUCCESS(f"    OK ({ocr_pass.method})"))
                    processed += 1
            except Exception as e:
                self.stderr.write(self.style.WARNING(f"    Error: {e}"))

        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'Would process' if self.dry_run else 'Processed'} {processed} page(s); "
                f"skipped {skipped}."
            )
        )

    def _confirm_force(self, pages) -> bool:
        if not self.force or self.dry_run:
            return True
        corrections = (
            Word.objects.filter(page__in=pages, corrected_text__isnull=False)
            .exclude(corrected_text="")
            .count()
        )
        if corrections == 0:
            return True
        self.stderr.write(
            self.style.WARNING(
                f"\nWARNING: {corrections} human-corrected Word(s) will be permanently "
                f"deleted across {len(pages)} page(s)."
            )
        )
        answer = input("Proceed and lose all corrections? [y/N] ").strip().lower()
        if answer != "y":
            self.stdout.write("Aborted.")
            return False
        return True
