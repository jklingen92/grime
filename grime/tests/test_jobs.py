"""Task management: job creation/cancel/rerun views, the OCR job type and the worker loop."""

from unittest import mock

from django.core.management import call_command
from django.urls import reverse
from django.utils import timezone

from grime.job_types import JOB_TYPES, OCRParamsForm
from grime.management.commands.run_worker import Command
from grime.models import AsyncJob, JobCancelled, OCRPass, Word
from grime.pipeline import ocr
from grime.tests.base import GrimeTestCase


def fake_ocr(words=("alpha", "beta")):
    rows = [
        {
            "text": t,
            "left": i * 50,
            "top": 0,
            "width": 40,
            "height": 10,
            "conf": 90.0,
            "line_num": 0,
            "word_num": i,
        }
        for i, t in enumerate(words)
    ]
    return mock.patch.object(
        ocr, "dispatch", return_value=(" ".join(words), 90.0, rows, "tesseract")
    )


class JobViewTests(GrimeTestCase):
    def setUp(self):
        super().setUp()
        self.make_staff()
        self.page = self.make_page()
        self.doc = self.page.document
        self.slot = self.make_slot()

    def create(self, **extra):
        data = {
            "job_type": "ocr",
            "document": self.doc.pk,
            "worker_slot": self.slot.pk,
            "engine": "tesseract",
            **extra,
        }
        return self.client.post(reverse("grime:job_create"), data)

    def test_staff_only(self):
        self.client.logout()
        self.assertEqual(self.create().status_code, 302)
        self.assertEqual(AsyncJob.objects.count(), 0)

    def test_create_ocr_job_with_params(self):
        res = self.create(force="on", page_pk=self.page.pk)
        self.assertEqual(res.json()["status"], "pending")
        job = AsyncJob.objects.get()
        self.assertEqual(job.params, {"engine": "tesseract", "page_pk": self.page.pk})
        self.assertTrue(job.force)
        self.assertEqual(job.worker_slot, self.slot)

    def test_create_validates_input(self):
        self.assertEqual(self.create(job_type="nope").status_code, 400)
        self.assertEqual(self.create(engine="magic").status_code, 400)
        self.assertEqual(self.create(document=9999).status_code, 400)
        self.assertEqual(AsyncJob.objects.count(), 0)

    def test_cancel_marks_pending_job_failed_but_leaves_finished_ones(self):
        job = AsyncJob.objects.create(
            document=self.doc, job_type="ocr", worker_slot=self.slot
        )
        done = AsyncJob.objects.create(
            document=self.doc, job_type="ocr", status=AsyncJob.STATUS_COMPLETE
        )
        self.client.post(reverse("grime:job_cancel", args=[job.pk]))
        self.client.post(reverse("grime:job_cancel", args=[done.pk]))
        job.refresh_from_db()
        done.refresh_from_db()
        self.assertEqual((job.status, job.error), ("failed", "Cancelled by user"))
        self.assertEqual(done.status, "complete")

    def test_rerun_cleans_and_resets_but_refuses_running_jobs(self):
        job = AsyncJob.objects.create(
            document=self.doc,
            job_type="ocr",
            status=AsyncJob.STATUS_COMPLETE,
            result={"x": 1},
            pages_done=1,
        )
        self.make_words(self.page, ["old"])
        self.client.post(reverse("grime:job_rerun", args=[job.pk]))
        job.refresh_from_db()
        self.assertEqual((job.status, job.result, job.pages_done), ("pending", {}, 0))
        self.assertFalse(Word.objects.exists())

        job.status = AsyncJob.STATUS_RUNNING
        job.save()
        self.assertEqual(
            self.client.post(reverse("grime:job_rerun", args=[job.pk])).status_code, 400
        )

    def test_poll_and_status(self):
        job = AsyncJob.objects.create(
            document=self.doc,
            job_type="ocr",
            worker_slot=self.slot,
            status=AsyncJob.STATUS_RUNNING,
            started_at=timezone.now(),
            pages_total=4,
            pages_done=1,
        )
        AsyncJob.objects.create(
            document=self.doc, job_type="ocr", worker_slot=self.slot
        )
        self.assertEqual(
            self.client.get(reverse("grime:job_poll", args=[job.pk])).json()[
                "pages_done"
            ],
            1,
        )
        data = self.client.get(reverse("grime:jobs_status")).json()
        self.assertEqual(data["pending_count"], 1)
        self.assertEqual(data["slots"][0]["job"]["pk"], job.pk)
        self.assertEqual(data["slots"][0]["pending_count"], 1)

    def test_status_expires_stale_running_jobs(self):
        job = AsyncJob.objects.create(
            document=self.doc, job_type="ocr", status=AsyncJob.STATUS_RUNNING
        )
        AsyncJob.objects.filter(pk=job.pk).update(
            updated_at=timezone.now() - timezone.timedelta(minutes=16)
        )
        self.client.get(reverse("grime:jobs_status"))
        job.refresh_from_db()
        self.assertEqual(
            (job.status, job.error), ("failed", "Worker stopped responding mid-job")
        )

    def test_rename_slot(self):
        url = reverse("grime:worker_slot_rename", args=[self.slot.slot_number])
        self.assertEqual(
            self.client.post(url, {"name": "  Fast  "}).json()["name"], "Fast"
        )
        self.assertEqual(self.client.post(url, {"name": " "}).status_code, 400)


class OCRJobTypeTests(GrimeTestCase):
    def setUp(self):
        super().setUp()
        self.page = self.make_page()
        self.job = AsyncJob.objects.create(
            document=self.page.document,
            job_type="ocr",
            status=AsyncJob.STATUS_RUNNING,
            params={"engine": "tesseract"},
        )

    def test_run_ocrs_pages_and_reports_progress(self):
        with fake_ocr():
            JOB_TYPES["ocr"].run(self.job)
        self.assertEqual(self.job.result, {"words_created": 2})
        self.assertEqual((self.job.pages_done, self.job.pages_total), (1, 1))
        self.assertEqual(self.job.results_summary(), "OCR'd 1 pages, 2 words extracted")
        self.assertEqual(self.job.progress(), {"done": 1, "total": 1})

    def test_skips_done_pages_unless_forced(self):
        with fake_ocr() as d:
            JOB_TYPES["ocr"].run(self.job)
            JOB_TYPES["ocr"].run(self.job)
            self.assertEqual(d.call_count, 1)
            self.job.force = True
            JOB_TYPES["ocr"].run(self.job)
            self.assertEqual(d.call_count, 2)
        self.assertEqual(self.page.words.count(), 2)  # replaced, not appended

    def test_page_pk_limits_scope(self):
        other = self.page.document.pages.create(page_number=2)
        self.job.params["page_pk"] = other.pk
        other.image.save("o.png", self.page.image.file, save=True)
        with fake_ocr():
            JOB_TYPES["ocr"].run(self.job)
        self.assertEqual(self.page.words.count(), 0)
        self.assertEqual(other.words.count(), 2)

    def test_cancel_stops_after_current_page(self):
        # Job row is not RUNNING in the DB -> check_cancelled raises after page 1.
        self.job.status = AsyncJob.STATUS_FAILED
        self.job.save()
        with fake_ocr(), self.assertRaises(JobCancelled):
            JOB_TYPES["ocr"].run(self.job)

    def test_clean_removes_ocr_output(self):
        with fake_ocr():
            JOB_TYPES["ocr"].run(self.job)
        JOB_TYPES["ocr"].clean(self.job)
        self.assertFalse(Word.objects.exists())
        self.assertFalse(OCRPass.objects.exists())

    def test_engine_form_defaults_to_auto(self):
        f = OCRParamsForm({})
        self.assertTrue(f.is_valid())
        self.assertEqual(f.cleaned_data["engine"], "auto")


class WorkerTests(GrimeTestCase):
    def setUp(self):
        super().setUp()
        self.page = self.make_page()
        self.slot = self.make_slot()
        self.cmd = Command()

    def job(self, **kw):
        return AsyncJob.objects.create(
            document=self.page.document,
            worker_slot=self.slot,
            job_type="ocr",
            params={"engine": "tesseract"},
            **kw,
        )

    def test_claim_takes_oldest_pending_job_for_this_slot_only(self):
        other = self.make_slot(2)
        AsyncJob.objects.create(
            document=self.page.document, worker_slot=other, job_type="ocr"
        )
        first, second = self.job(), self.job()
        claimed = self.cmd._claim_job(self.slot)
        self.assertEqual(claimed.pk, first.pk)
        self.assertEqual(claimed.status, "running")
        self.assertIsNotNone(claimed.started_at)
        self.assertEqual(self.cmd._claim_job(self.slot).pk, second.pk)
        self.assertIsNone(self.cmd._claim_job(self.slot))

    def test_successful_run_completes_job(self):
        job = self.job()
        claimed = self.cmd._claim_job(self.slot)
        with fake_ocr():
            self.cmd._run_job(claimed)
        job.refresh_from_db()
        self.assertEqual((job.status, job.result), ("complete", {"words_created": 2}))
        self.assertIsNotNone(job.completed_at)

    def test_handler_exception_fails_job(self):
        job = self.job()
        claimed = self.cmd._claim_job(self.slot)
        with mock.patch.object(
            ocr, "dispatch", side_effect=RuntimeError("tesseract exploded")
        ):
            self.cmd._run_job(claimed)
        job.refresh_from_db()
        self.assertEqual((job.status, job.error), ("failed", "tesseract exploded"))

    def test_cancel_during_run_cleans_up_and_stays_failed(self):
        job = self.job()
        claimed = self.cmd._claim_job(self.slot)

        def cancel_midway(*a, **k):
            AsyncJob.objects.filter(pk=job.pk).update(
                status=AsyncJob.STATUS_FAILED, error="Cancelled by user"
            )
            return "t", 90.0, [], "tesseract"

        with mock.patch.object(ocr, "dispatch", side_effect=cancel_midway):
            self.cmd._run_job(claimed)
        job.refresh_from_db()
        self.assertEqual((job.status, job.error), ("failed", "Cancelled by user"))
        self.assertFalse(OCRPass.objects.exists())

    def test_startup_fails_orphaned_running_jobs(self):
        job = self.job(status=AsyncJob.STATUS_RUNNING)
        # Stop the poll loop on its first empty-queue sleep.
        stop = lambda _: setattr(self.cmd, "_shutting_down", True)  # noqa: E731
        with mock.patch("signal.signal"), mock.patch("time.sleep", side_effect=stop):
            self.cmd.handle(slot=1, poll_interval=0)
        job.refresh_from_db()
        self.assertEqual(
            (job.status, job.error),
            ("failed", "Worker restarted while job was running"),
        )

    def test_unknown_slot_exits_quietly(self):
        call_command("run_worker", slot=99, stderr=mock.Mock())
