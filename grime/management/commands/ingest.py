"""
Ingest a PDF or directory of files into Document + DocumentPage records.

PDF mode (single file)::

    python manage.py ingest colorado_ledger.pdf
    python manage.py ingest colorado_ledger.pdf --output media/documents/colorado_ledger/
    python manage.py ingest colorado_ledger.pdf --pages 3-7
    python manage.py ingest colorado_ledger.pdf --pages 1-5,8,10
    python manage.py ingest colorado_ledger.pdf --dry-run

Directory mode::

    python manage.py ingest /path/to/scans/
    python manage.py ingest /path/to/scans/ --force
"""

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from grime.pipeline.ingest import ingest_directory, ingest_pdf


class Command(BaseCommand):
    help = (
        "Ingest a PDF or directory into Document + DocumentPage records.\n\n"
        "  ingest <pdf>        — split a PDF into pages\n"
        "  ingest <directory>  — every file becomes a page of one Document"
    )

    def add_arguments(self, parser):
        parser.add_argument("path", help="PDF file or directory to ingest")
        parser.add_argument(
            "--dry-run", action="store_true", help="Report without writing"
        )
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
            "--pages",
            default=None,
            metavar="RANGE",
            help=(
                "Page range to ingest, print-dialog style (e.g. ``1-5,8,10``). "
                "PDF mode only; defaults to all pages."
            ),
        )

    def handle(self, *args, **options):
        target = Path(options["path"])
        if not target.exists():
            raise CommandError(f"Path not found: {target}")

        dry_run = options["dry_run"]
        force = options["force"]

        if target.is_file():
            if target.suffix.lower() != ".pdf":
                raise CommandError("Single-file mode only supports PDFs.")
            try:
                doc, created_count, skipped = ingest_pdf(
                    target,
                    output_dir=Path(options["output"]) if options["output"] else None,
                    page_range_spec=options["pages"],
                    force=force,
                    dry_run=dry_run,
                    log=self.stdout.write,
                )
            except (ValueError, ImportError) as exc:
                raise CommandError(str(exc)) from exc
        else:
            if options["pages"]:
                self.stderr.write(
                    self.style.WARNING("  --pages is ignored in directory mode.")
                )
            try:
                doc, created_count, skipped = ingest_directory(
                    target,
                    force=force,
                    dry_run=dry_run,
                    log=self.stdout.write,
                )
            except (ValueError, ImportError) as exc:
                raise CommandError(str(exc)) from exc

        label = "document" if target.is_dir() else ""
        self.stdout.write(
            self.style.SUCCESS(
                f"\n{'Would create' if dry_run else 'Created'} "
                + (f"1 {label}, " if label else "")
                + f"{created_count} page(s); skipped {skipped}."
            )
        )
        if not dry_run and doc:
            self.stdout.write(self.style.SUCCESS(f"View at {doc.get_absolute_url()}"))
