"""
Celery task for background job processing.

A single run_job task handles all job types via the handler registry in
grime/job_types.py. The task owns one AsyncJob row, updating its status,
pages_done, and error fields as it progresses.
"""

import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True)
def run_job(self, job_pk: int) -> None:
    from grime.models import AsyncJob

    logger.info("run_job received: job_pk=%d task_id=%s", job_pk, self.request.id)
    job = AsyncJob.objects.get(pk=job_pk)
    if job.status not in (AsyncJob.STATUS_PENDING, AsyncJob.STATUS_RUNNING):
        logger.info("Job %d status=%s, skipping stale broker message", job_pk, job.status)
        return

    job.status = AsyncJob.STATUS_RUNNING
    job.task_id = self.request.id
    job.started_at = timezone.now()
    job.save()

    logger.info(
        "Job %d starting: type=%s doc='%s' force=%s params=%s",
        job_pk, job.job_type, job.document, job.force, job.params,
    )
    try:
        job.handler.run(job)
        job.status = AsyncJob.STATUS_COMPLETE
        job.completed_at = timezone.now()
        job.save()
        logger.info("Job %d complete", job_pk)
    except Exception as exc:
        logger.exception("Job %d (%s) failed: %s", job_pk, job.job_type, exc)
        job.status = AsyncJob.STATUS_FAILED
        job.error = str(exc)
        job.completed_at = timezone.now()
        job.save()
        raise
