"""
Run HuggingFace historical NER on a Document's pages.

Annotates ``Word.ner_label`` with BIO entity labels (B-PER, I-PER, B-LOC,
I-LOC, B-ORG, I-ORG) and records each run as a ``NERPass``.

Examples::

    python manage.py ner --document 42
    python manage.py ner --document 42 --page 5
    python manage.py ner --document 42 --threshold 0.85
    python manage.py ner --document 42 --force
    python manage.py ner --document 42 --dry-run

Requires the ``[hf]`` optional dependencies::

    pip install -e ".[hf]"
"""

from django.core.management.base import BaseCommand, CommandError

from grime.models import Document, NERPass, Word

SCHEMA_NAME = "hf-historical-ner"


class Command(BaseCommand):
    help = "Run HuggingFace historical NER on a document's pages; annotates Word.ner_label."

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
            "--threshold",
            type=float,
            metavar="SCORE",
            help="Minimum model confidence for an entity to be included",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be processed without writing to the database",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help=(
                "Re-run even if a NERPass exists. Clears NERPass + resets Word.ner_label "
                "(corrected_label is preserved)."
            ),
        )

    def handle(self, **options):
        self.dry_run = options["dry_run"]
        self.force = options["force"]

        from grime.pipeline.ner import DEFAULT_CONFIDENCE_THRESHOLD

        self.threshold = options["threshold"] or DEFAULT_CONFIDENCE_THRESHOLD

        doc = self._resolve_document(options["document"])
        pages_qs = doc.pages.order_by("page_number")
        if options["page"] is not None:
            pages_qs = pages_qs.filter(page_number=options["page"])
        pages = [p for p in pages_qs if p.text]
        if not pages:
            self.stdout.write(
                self.style.WARNING(f"No pages with text found for '{doc}'.")
            )
            return
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
        if NERPass.objects.filter(page=page, schema_name=SCHEMA_NAME).exists():
            return True, "skipped (NERPass exists; use --force to re-run)"
        return False, ""

    def _run_pages(self, pages, label):
        self.stdout.write(f"{label} — {len(pages)} page(s) to process")
        if not self.dry_run:
            self.stdout.write(
                "Loading model (first run will download weights ~440 MB)…"
            )
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
                n_labelled = self._process_page(page)
                self.stdout.write(
                    self.style.SUCCESS(f"    OK — {n_labelled} word(s) labelled")
                )
                processed += 1
            except Exception as e:
                self.stderr.write(self.style.WARNING(f"    Error: {e}"))
        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'Would process' if self.dry_run else 'Processed'} {processed} page(s); "
                f"skipped {skipped}."
            )
        )

    def _process_page(self, page) -> int:
        from grime.pipeline.ner import extract_entities, label_ocr_words

        if self.force:
            NERPass.objects.filter(page=page, schema_name=SCHEMA_NAME).delete()
            Word.objects.filter(page=page).update(ner_label=None)

        entities = extract_entities(page.text, confidence_threshold=self.threshold)
        ner_pass = NERPass.objects.create(
            page=page,
            schema_name=SCHEMA_NAME,
            method="hf-historical-ner",
            used_llm=False,
            threshold=self.threshold,
            status=NERPass.STATUS_COMPLETE,
        )
        words = list(Word.objects.filter(page=page).order_by("line_num", "word_num"))
        label_ocr_words(words, page.text, entities)
        # Link the labelled words back to this NERPass run for traceability.
        labelled = [w for w in words if w.ner_label]
        if labelled:
            for w in labelled:
                w.ner_pass = ner_pass
            Word.objects.bulk_update(labelled, ["ner_pass"])
        return len(labelled)
