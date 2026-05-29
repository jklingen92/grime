"""
Long-running worker process that drains AsyncJobs for one WorkerSlot.

Polls the AsyncJob table for PENDING jobs assigned to its slot, claims one at
a time atomically, runs the handler, and updates job status. Replaces the
former Celery worker — all job state lives in the AsyncJob row, no broker.

Run one process per slot:

    python manage.py run_worker --slot=1
    python manage.py run_worker --slot=2
    python manage.py run_worker --slot=3

The Procfile starts these alongside `runserver` via honcho.
"""

import logging
import signal
import time

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from grime.models import AsyncJob, JobCancelled, WorkerSlot

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Run a worker that processes AsyncJobs assigned to a slot."

    def add_arguments(self, parser):
        parser.add_argument("--slot", type=int, required=True, help="WorkerSlot.slot_number to serve")
        parser.add_argument("--poll-interval", type=float, default=2.0, help="Seconds between empty-queue polls")

    def handle(self, *args, slot, poll_interval, **kwargs):
        slot_obj = WorkerSlot.objects.filter(slot_number=slot).first()
        if slot_obj is None:
            self.stderr.write(f"No WorkerSlot with slot_number={slot}")
            return

        logger.info("Worker for slot %d (%s) starting", slot, slot_obj.name)

        # Any RUNNING job assigned to this slot is an orphan from a previous
        # crashed/killed worker. Mark them FAILED so they don't stay stuck.
        orphaned = AsyncJob.objects.filter(
            worker_slot=slot_obj, status=AsyncJob.STATUS_RUNNING,
        ).update(
            status=AsyncJob.STATUS_FAILED,
            error="Worker restarted while job was running",
            completed_at=timezone.now(),
        )
        if orphaned:
            logger.info("Marked %d stale RUNNING job(s) as failed on startup", orphaned)

        self._shutting_down = False
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

        while not self._shutting_down:
            job = self._claim_job(slot_obj)
            if job is None:
                time.sleep(poll_interval)
                continue
            self._run_job(job)

        logger.info("Worker for slot %d shut down", slot)

    def _on_signal(self, *_):
        logger.info("Signal received, stopping after current job")
        self._shutting_down = True

    def _claim_job(self, slot_obj: WorkerSlot) -> AsyncJob | None:
        """Atomically claim the oldest PENDING job for this slot."""
        with transaction.atomic():
            job = (
                AsyncJob.objects
                .select_for_update(skip_locked=True)
                .filter(worker_slot=slot_obj, status=AsyncJob.STATUS_PENDING)
                .order_by("created_at")
                .first()
            )
            if job is None:
                return None
            job.status = AsyncJob.STATUS_RUNNING
            job.started_at = timezone.now()
            job.save(update_fields=["status", "started_at"])
            return job

    def _run_job(self, job: AsyncJob) -> None:
        logger.info(
            "Job %d starting: type=%s doc='%s' force=%s params=%s",
            job.pk, job.job_type, job.document, job.force, job.params,
        )
        try:
            job.handler.run(job)
        except JobCancelled as exc:
            logger.info("Job %d cancelled mid-run: %s — running clean()", job.pk, exc)
            try:
                job.handler.clean(job)
            except Exception:
                logger.exception("Job %d clean() failed after cancel", job.pk)
            return
        except Exception as exc:
            logger.exception("Job %d (%s) failed: %s", job.pk, job.job_type, exc)
            job.status = AsyncJob.STATUS_FAILED
            job.error = str(exc)
            job.completed_at = timezone.now()
            job.save()
            return

        # run() returned normally, but cancel may have fired during the last
        # page (after its check_cancelled() but before the loop ended).
        # Re-read status; if it's no longer RUNNING, honour it.
        job.refresh_from_db(fields=["status"])
        if job.status != AsyncJob.STATUS_RUNNING:
            logger.info("Job %d finished but status already changed to %r — not marking complete", job.pk, job.status)
            try:
                job.handler.clean(job)
            except Exception:
                logger.exception("Job %d clean() failed after late cancel", job.pk)
            return

        job.status = AsyncJob.STATUS_COMPLETE
        job.completed_at = timezone.now()
        job.save()
        logger.info("Job %d complete", job.pk)
