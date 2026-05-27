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

    job = AsyncJob.objects.get(pk=job_pk)
    if job.status == AsyncJob.STATUS_COMPLETE:
        return  # broker re-queued after a blip — work already done

    job.status = AsyncJob.STATUS_RUNNING
    job.task_id = self.request.id
    job.started_at = timezone.now()
    job.save()

    try:
        job.handler.run(job)
        job.status = AsyncJob.STATUS_COMPLETE
        job.completed_at = timezone.now()
        job.save()
    except Exception as exc:
        logger.exception("Job %d (%s) failed", job_pk, job.job_type)
        job.status = AsyncJob.STATUS_FAILED
        job.error = str(exc)
        job.completed_at = timezone.now()
        job.save()
        raise
