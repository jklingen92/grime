"""
Job type registry for AsyncJob.

To add a new job type: subclass JobType, implement run/clean/results_summary,
set a key and label, and add the class to JOB_TYPES. See DEV_README.md for details.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from django import forms
from django.utils import timezone

from grime.pipeline.ner import DEFAULT_MODEL, MODEL_LABELS, MODEL_REGISTRY

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
        required=False,
        widget=forms.Select(attrs={"class": "form-select form-select-sm"}),
    )

    def clean_engine(self):
        return self.cleaned_data.get("engine") or "auto"


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
        page_pk = job.params.get("page_pk")
        if page_pk:
            pages = [p for p in pages if p.pk == int(page_pk)]
        if not job.force:
            ocrd_ids = set(
                OCRPass.objects.filter(page__in=pages).values_list("page_id", flat=True)
            )
            pages = [p for p in pages if p.pk not in ocrd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        from grime.models import AsyncJob as _AsyncJob
        _AsyncJob.objects.filter(pk=job.pk).update(
            pages_total=len(pages), pages_done=0, updated_at=timezone.now()
        )

        logger.info("[OCR job %d] engine=%s, processing %d page(s)", job.pk, engine or "auto", len(pages))

        words_created = 0
        for page in pages:
            page_label = f"p.{page.page_number}" if page.page_number is not None else f"page pk={page.pk}"
            logger.info("[OCR job %d] Processing %s (%d/%d)", job.pk, page_label, job.pages_done + 1, job.pages_total)
            Word.objects.filter(page=page).delete()
            OCRPass.objects.filter(page=page).delete()
            run_page(page, engine=engine, force=True)
            words = page.words.count()
            words_created += words
            logger.info("[OCR job %d] %s done — %d word(s) extracted", job.pk, page_label, words)
            job.pages_done += 1
            _AsyncJob.objects.filter(pk=job.pk).update(
                pages_done=job.pages_done, updated_at=timezone.now()
            )
            print(f"[OCR job {job.pk}] check_cancelled after {page_label}", flush=True)
            job.check_cancelled()

        logger.info("[OCR job %d] Complete — %d word(s) across %d page(s)", job.pk, words_created, job.pages_done)
        job.result = {"words_created": words_created}

    def clean(self, job: "AsyncJob") -> None:
        from grime.models import OCRPass, Word

        page_pk = job.params.get("page_pk")
        if page_pk:
            page_ids = [int(page_pk)]
        else:
            page_ids = list(job.document.pages.values_list("pk", flat=True))
        Word.objects.filter(page_id__in=page_ids).delete()
        OCRPass.objects.filter(page_id__in=page_ids).delete()

    def results_summary(self, job: "AsyncJob") -> str:
        w = job.result.get("words_created", 0)
        return f"OCR'd {job.pages_done} pages, {w} words extracted"


# ---------------------------------------------------------------------------
# NER
# ---------------------------------------------------------------------------

class NERParamsForm(forms.Form):
    model = forms.ChoiceField(
        label="NER model",
        choices=[(k, MODEL_LABELS.get(k, k.capitalize())) for k in MODEL_REGISTRY],
        initial=DEFAULT_MODEL,
        required=False,
        widget=forms.Select(attrs={"class": "form-select form-select-sm"}),
    )

    def clean_model(self):
        return self.cleaned_data.get("model") or DEFAULT_MODEL


class NERJobType(JobType):
    key = "ner"
    label = "NER"
    params_form_class = NERParamsForm

    def _schema_name(self, model_key: str) -> str:
        return f"hf-ner-{model_key}"

    def run(self, job: "AsyncJob") -> None:
        from grime.models import NERPass, Word
        from grime.pipeline.ner import (
            DEFAULT_CONFIDENCE_THRESHOLD,
            MODEL_REGISTRY,
            _pipelines,
            extract_entities,
            label_ocr_words,
        )

        model_key = job.params.get("model") or DEFAULT_MODEL
        schema_name = self._schema_name(model_key)
        model_id = MODEL_REGISTRY.get(model_key, model_key)

        pages = list(job.document.pages.order_by("page_number"))
        page_pk = job.params.get("page_pk")
        if page_pk:
            pages = [p for p in pages if p.pk == int(page_pk)]
        if not job.force:
            nerd_ids = set(
                NERPass.objects.filter(
                    page__in=pages, schema_name=schema_name
                ).values_list("page_id", flat=True)
            )
            pages = [p for p in pages if p.pk not in nerd_ids]

        job.pages_total = len(pages)
        job.pages_done = 0
        from grime.models import AsyncJob as _AsyncJob
        _AsyncJob.objects.filter(pk=job.pk).update(
            pages_total=len(pages), pages_done=0, updated_at=timezone.now()
        )

        if model_key not in _pipelines:
            logger.info(
                "[NER job %d] Loading model '%s' (%s) — may download weights on first use",
                job.pk, model_key, model_id,
            )
        else:
            logger.info(
                "[NER job %d] Using cached model '%s', processing %d page(s)",
                job.pk, model_key, len(pages),
            )

        entities_found = 0
        for page in pages:
            page_label = f"p.{page.page_number}" if page.page_number is not None else f"page pk={page.pk}"
            logger.info("[NER job %d] Processing %s (%d/%d)", job.pk, page_label, job.pages_done + 1, job.pages_total)
            NERPass.objects.filter(page=page, schema_name=schema_name).delete()
            Word.objects.filter(page=page).update(ner_label=None)
            entities = extract_entities(
                page.text,
                confidence_threshold=DEFAULT_CONFIDENCE_THRESHOLD,
                model=model_key,
            )
            ner_pass = NERPass.objects.create(
                page=page,
                schema_name=schema_name,
                method=f"hf-ner-{model_key}",
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
            logger.info("[NER job %d] %s done — %d entity word(s) labelled", job.pk, page_label, len(labelled))

            job.pages_done += 1
            _AsyncJob.objects.filter(pk=job.pk).update(
                pages_done=job.pages_done, updated_at=timezone.now()
            )
            print(f"[NER job {job.pk}] check_cancelled after {page_label}", flush=True)
            job.check_cancelled()

        logger.info("[NER job %d] Complete — %d entity word(s) across %d page(s)", job.pk, entities_found, job.pages_done)
        job.result = {"entities_found": entities_found}

    def clean(self, job: "AsyncJob") -> None:
        from grime.models import NERPass, Word

        page_pk = job.params.get("page_pk")
        if page_pk:
            page_ids = [int(page_pk)]
        else:
            page_ids = list(job.document.pages.values_list("pk", flat=True))
        NERPass.objects.filter(page_id__in=page_ids).delete()
        Word.objects.filter(page_id__in=page_ids).update(ner_label=None)

    def results_summary(self, job: "AsyncJob") -> str:
        model_key = job.params.get("model") or DEFAULT_MODEL
        label = MODEL_LABELS.get(model_key, model_key)
        e = job.result.get("entities_found", 0)
        return f"NER'd {job.pages_done} pages, {e} entities found ({label})"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

JOB_TYPES: dict[str, JobType] = {t.key: t() for t in [OCRJobType, NERJobType]}
