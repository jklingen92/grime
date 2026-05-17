"""
Celery tasks for background OCR and NER processing on whole Documents.

Each task owns one AsyncJob row (identified by job_pk) and updates its
``status``, ``pages_done``, and ``error`` fields as it progresses.
"""

import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True)
def run_ocr_job(self, job_pk: int) -> None:
    from grime.models import AsyncJob, OCRPass, Word
    from grime.pipeline.ocr import run_page

    job = AsyncJob.objects.get(pk=job_pk)
    if job.status == AsyncJob.STATUS_COMPLETE:
        return  # Celery re-queued after a broker blip — work already done
    job.status = AsyncJob.STATUS_RUNNING
    job.task_id = self.request.id
    job.save(update_fields=["status", "task_id"])

    try:
        pages = list(job.document.pages.order_by("page_number"))
        if job.new_only:
            ocrd_ids = set(
                OCRPass.objects.filter(page__in=pages).values_list("page_id", flat=True)
            )
            pages = [p for p in pages if p.pk not in ocrd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        job.save(update_fields=["pages_total", "pages_done"])

        for page in pages:
            if not job.new_only:
                Word.objects.filter(page=page).delete()
            run_page(page, engine=None, force=not job.new_only)
            job.pages_done += 1
            job.save(update_fields=["pages_done"])

        job.status = AsyncJob.STATUS_COMPLETE
        job.completed_at = timezone.now()
        job.save(update_fields=["status", "completed_at"])

    except Exception as exc:
        logger.exception("OCR job %d failed", job_pk)
        job.status = AsyncJob.STATUS_FAILED
        job.error = str(exc)
        job.completed_at = timezone.now()
        job.save(update_fields=["status", "error", "completed_at"])
        raise


@shared_task(bind=True)
def run_ner_job(self, job_pk: int) -> None:
    from grime.models import AsyncJob, NERPass, Word
    from grime.pipeline.ner import DEFAULT_CONFIDENCE_THRESHOLD, extract_entities, label_ocr_words

    SCHEMA_NAME = "hf-historical-ner"
    job = AsyncJob.objects.get(pk=job_pk)
    if job.status == AsyncJob.STATUS_COMPLETE:
        return  # Celery re-queued after a broker blip — work already done
    job.status = AsyncJob.STATUS_RUNNING
    job.task_id = self.request.id
    job.save(update_fields=["status", "task_id"])

    try:
        pages = list(job.document.pages.order_by("page_number"))
        if job.new_only:
            nerd_ids = set(
                NERPass.objects.filter(page__in=pages, schema_name=SCHEMA_NAME).values_list(
                    "page_id", flat=True
                )
            )
            pages = [p for p in pages if p.pk not in nerd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        job.save(update_fields=["pages_total", "pages_done"])

        for page in pages:
            if not job.new_only:
                NERPass.objects.filter(page=page, schema_name=SCHEMA_NAME).delete()
                Word.objects.filter(page=page).update(ner_label=None)

            entities = extract_entities(page.text, confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD)
            ner_pass = NERPass.objects.create(
                page=page,
                schema_name=SCHEMA_NAME,
                method="hf-historical-ner",
                used_llm=False,
                threshold=DEFAULT_CONFIDENCE_THRESHOLD,
                status=NERPass.STATUS_COMPLETE,
            )
            words = list(Word.objects.filter(page=page).order_by("line_num", "word_num"))
            label_ocr_words(words, page.text, entities)
            labelled = [w for w in words if w.ner_label]
            if labelled:
                for w in labelled:
                    w.ner_pass = ner_pass
                Word.objects.bulk_update(labelled, ["ner_pass"])

            job.pages_done += 1
            job.save(update_fields=["pages_done"])

        job.status = AsyncJob.STATUS_COMPLETE
        job.completed_at = timezone.now()
        job.save(update_fields=["status", "completed_at"])

    except Exception as exc:
        logger.exception("NER job %d failed", job_pk)
        job.status = AsyncJob.STATUS_FAILED
        job.error = str(exc)
        job.completed_at = timezone.now()
        job.save(update_fields=["status", "error", "completed_at"])
        raise
