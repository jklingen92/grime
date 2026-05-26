"""
Job type registry for AsyncJob.

To add a new job type: subclass JobType, implement run/clean/results_summary,
set a key and label, and add the class to JOB_TYPES. See DEV_README.md for details.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from django import forms

if TYPE_CHECKING:
    from grime.models import AsyncJob

logger = logging.getLogger(__name__)


class JobType:
    key: str = ""
    label: str = ""
    params_form_class: type[forms.Form] | None = None

    def run(self, job: "AsyncJob") -> None:
        raise NotImplementedError

    def clean(self, job: "AsyncJob") -> None:
        raise NotImplementedError

    def progress(self, job: "AsyncJob") -> dict:
        return {"done": job.pages_done, "total": job.pages_total}

    def results_summary(self, job: "AsyncJob") -> str:
        return ""


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------

class OCRParamsForm(forms.Form):
    engine = forms.ChoiceField(
        choices=[("auto", "Auto"), ("textract", "Textract"), ("tesseract", "Tesseract")],
        initial="auto",
        widget=forms.Select(attrs={"class": "form-select form-select-sm"}),
    )


class OCRJobType(JobType):
    key = "ocr"
    label = "OCR"
    params_form_class = OCRParamsForm

    def run(self, job: "AsyncJob") -> None:
        from grime.models import OCRPass, Word
        from grime.pipeline.ocr import run_page

        engine = job.params.get("engine") or None
        if engine == "auto":
            engine = None

        pages = list(job.document.pages.order_by("page_number"))
        if not job.force:
            ocrd_ids = set(
                OCRPass.objects.filter(page__in=pages).values_list("page_id", flat=True)
            )
            pages = [p for p in pages if p.pk not in ocrd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        job.save()

        words_created = 0
        for page in pages:
            if job.force:
                Word.objects.filter(page=page).delete()
            run_page(page, engine=engine, force=job.force)
            words_created += Word.objects.filter(page=page).count()
            job.pages_done += 1
            job.save()

        job.result = {"words_created": words_created}

    def clean(self, job: "AsyncJob") -> None:
        from grime.models import OCRPass, Word

        page_ids = list(job.document.pages.values_list("pk", flat=True))
        Word.objects.filter(page_id__in=page_ids).delete()
        OCRPass.objects.filter(page_id__in=page_ids).delete()

    def results_summary(self, job: "AsyncJob") -> str:
        w = job.result.get("words_created", 0)
        return f"OCR'd {job.pages_done} pages, {w} words extracted"


# ---------------------------------------------------------------------------
# NER
# ---------------------------------------------------------------------------

class NERJobType(JobType):
    key = "ner"
    label = "NER"
    params_form_class = None

    SCHEMA_NAME = "hf-historical-ner"

    def run(self, job: "AsyncJob") -> None:
        from grime.models import NERPass, Word
        from grime.pipeline.ner import DEFAULT_CONFIDENCE_THRESHOLD, extract_entities, label_ocr_words

        pages = list(job.document.pages.order_by("page_number"))
        if not job.force:
            nerd_ids = set(
                NERPass.objects.filter(
                    page__in=pages, schema_name=self.SCHEMA_NAME
                ).values_list("page_id", flat=True)
            )
            pages = [p for p in pages if p.pk not in nerd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        job.save()

        entities_found = 0
        for page in pages:
            if job.force:
                NERPass.objects.filter(page=page, schema_name=self.SCHEMA_NAME).delete()
                Word.objects.filter(page=page).update(ner_label=None)

            entities = extract_entities(
                page.text, confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD
            )
            ner_pass = NERPass.objects.create(
                page=page,
                schema_name=self.SCHEMA_NAME,
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
                entities_found += len(labelled)

            job.pages_done += 1
            job.save()

        job.result = {"entities_found": entities_found}

    def clean(self, job: "AsyncJob") -> None:
        from grime.models import NERPass, Word

        page_ids = list(job.document.pages.values_list("pk", flat=True))
        NERPass.objects.filter(page_id__in=page_ids, schema_name=self.SCHEMA_NAME).delete()
        Word.objects.filter(page_id__in=page_ids).update(ner_label=None)

    def results_summary(self, job: "AsyncJob") -> str:
        e = job.result.get("entities_found", 0)
        return f"NER'd {job.pages_done} pages, {e} entities found"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

JOB_TYPES: dict[str, JobType] = {t.key: t() for t in [OCRJobType, NERJobType]}
