"""
Job management views.

All async-job endpoints live here, keeping viewer.py focused on the page viewer.
Jobs are persisted as AsyncJob rows; one `python manage.py run_worker --slot=N`
process per WorkerSlot polls and runs them. See grime/management/commands/run_worker.py.
"""

import datetime
import logging

from django.contrib.admin.views.decorators import staff_member_required
from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST

from grime.forms import CreateJobForm
from grime.job_types import JOB_TYPES
from grime.models import AsyncJob, WorkerSlot

logger = logging.getLogger(__name__)


@staff_member_required
def jobs_list_view(request):
    jobs = AsyncJob.objects.select_related("document", "worker_slot").order_by("-created_at")[:200]
    return render(request, "grime/jobs_list.html", {"jobs": jobs})


@staff_member_required
@require_POST
def create_job(request):
    form = CreateJobForm(request.POST)
    if not form.is_valid():
        return JsonResponse({"error": form.errors.as_text()}, status=400)

    cd = form.cleaned_data
    job_type = cd["job_type"]
    handler = JOB_TYPES.get(job_type)
    if handler is None:
        return JsonResponse({"error": f"Unknown job type: {job_type}"}, status=400)

    # Validate type-specific params if the handler has a form
    params = {}
    if handler.params_form_class:
        pf = handler.params_form_class(request.POST)
        if not pf.is_valid():
            return JsonResponse({"error": pf.errors.as_text()}, status=400)
        params = pf.cleaned_data

    if cd.get("page_pk"):
        params["page_pk"] = cd["page_pk"]

    from grime.models import Document

    try:
        document = Document.objects.get(pk=cd["document"])
        worker_slot = WorkerSlot.objects.get(pk=cd["worker_slot"])
    except (Document.DoesNotExist, WorkerSlot.DoesNotExist) as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    job = AsyncJob.objects.create(
        document=document,
        worker_slot=worker_slot,
        job_type=job_type,
        force=cd["force"],
        params=params,
    )
    logger.info(
        "Created job %d (%s) for slot %d, params=%s",
        job.pk, job.job_type, worker_slot.slot_number, params,
    )
    return JsonResponse({"job_id": job.pk, "status": job.status})


@staff_member_required
def job_form_fields(request):
    """Return a rendered HTML fragment of the params form for the given job type."""
    job_type = request.GET.get("type", "")
    handler = JOB_TYPES.get(job_type)
    if handler is None:
        return JsonResponse({"error": "Unknown job type"}, status=400)

    form = handler.params_form_class() if handler.params_form_class else None
    template = f"grime/job_form_fields/{job_type}.html"
    return render(request, template, {"form": form})


@staff_member_required
def jobs_status(request):
    """
    Return current worker slot state, pending count, and recent jobs.

    Auto-expires stale jobs:
      - PENDING > 2 min   → broker likely unreachable
      - RUNNING, updated_at > 15 min → worker likely died
    """
    now = timezone.now()
    pending_cutoff = now - datetime.timedelta(minutes=2)
    running_cutoff = now - datetime.timedelta(minutes=15)

    stale = AsyncJob.objects.filter(
        status__in=[AsyncJob.STATUS_PENDING, AsyncJob.STATUS_RUNNING],
    ).filter(
        Q(status=AsyncJob.STATUS_PENDING, created_at__lt=pending_cutoff)
        | Q(status=AsyncJob.STATUS_RUNNING, updated_at__lt=running_cutoff)
    )
    stale.update(
        status=AsyncJob.STATUS_FAILED,
        error="Job timed out (worker or broker unavailable)",
        completed_at=now,
    )

    slots = WorkerSlot.objects.order_by("slot_number")
    # Map first running job per slot (ordered by created_at asc)
    running = list(
        AsyncJob.objects.filter(status=AsyncJob.STATUS_RUNNING)
        .select_related("document", "worker_slot")
        .order_by("created_at")
    )
    running_by_slot: dict[int, AsyncJob] = {}
    for job in running:
        if job.worker_slot_id and job.worker_slot_id not in running_by_slot:
            running_by_slot[job.worker_slot_id] = job

    # Count pending jobs per slot
    from django.db.models import Count
    pending_by_slot = dict(
        AsyncJob.objects.filter(status=AsyncJob.STATUS_PENDING)
        .values("worker_slot_id")
        .annotate(n=Count("id"))
        .values_list("worker_slot_id", "n")
    )

    slots_data = []
    for slot in slots:
        job = running_by_slot.get(slot.pk)
        slots_data.append({
            "pk": slot.pk,
            "slot_number": slot.slot_number,
            "name": slot.name,
            "job": _job_to_dict(job) if job else None,
            "pending_count": pending_by_slot.get(slot.pk, 0),
        })

    pending_count = AsyncJob.objects.filter(status=AsyncJob.STATUS_PENDING).count()

    recent = list(
        AsyncJob.objects.filter(
            status__in=[AsyncJob.STATUS_COMPLETE, AsyncJob.STATUS_FAILED]
        )
        .select_related("document", "worker_slot")
        .order_by("-completed_at")[:10]
    )

    return JsonResponse({
        "slots": slots_data,
        "pending_count": pending_count,
        "recent": [_job_to_dict(j) for j in recent],
    })


@staff_member_required
def poll_job(request, job_pk):
    """Return current status of a single job for the viewer spinner."""
    job = get_object_or_404(AsyncJob, pk=job_pk)
    return JsonResponse({
        "status": job.status,
        "pages_done": job.pages_done,
        "pages_total": job.pages_total,
        "error": job.error,
    })


@staff_member_required
@require_POST
def cancel_job(request, job_pk):
    """Mark a PENDING/RUNNING job as FAILED. A RUNNING worker will see the
    status change on its next check_cancelled() call and bail out."""
    job = get_object_or_404(AsyncJob, pk=job_pk)
    if job.status in (AsyncJob.STATUS_PENDING, AsyncJob.STATUS_RUNNING):
        job.status = AsyncJob.STATUS_FAILED
        job.error = "Cancelled by user"
        job.completed_at = timezone.now()
        job.save(update_fields=["status", "error", "completed_at"])
    return redirect(request.META.get("HTTP_REFERER") or reverse("grime:jobs_list"))


@staff_member_required
@require_POST
def rerun_job(request, job_pk):
    job = get_object_or_404(AsyncJob, pk=job_pk)
    try:
        job.rerun()
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    return redirect(request.META.get("HTTP_REFERER") or reverse("grime:jobs_list"))


@staff_member_required
@require_POST
def rename_worker_slot(request, slot_number):
    slot = get_object_or_404(WorkerSlot, slot_number=slot_number)
    name = request.POST.get("name", "").strip()
    if not name:
        return JsonResponse({"error": "Name cannot be empty"}, status=400)
    slot.name = name
    slot.save(update_fields=["name"])
    return JsonResponse({"slot_number": slot.slot_number, "name": slot.name})


def _job_to_dict(job: AsyncJob) -> dict:
    elapsed = job.elapsed_time()
    return {
        "pk": job.pk,
        "job_type": job.job_type,
        "job_type_label": JOB_TYPES[job.job_type].label if job.job_type in JOB_TYPES else job.job_type,
        "status": job.status,
        "document": str(job.document),
        "document_id": job.document_id,
        "worker_slot": job.worker_slot.name if job.worker_slot else None,
        "pages_done": job.pages_done,
        "pages_total": job.pages_total,
        "force": job.force,
        "error": job.error,
        "results_summary": job.results_summary() if job.status == AsyncJob.STATUS_COMPLETE else "",
        "elapsed_seconds": elapsed.total_seconds() if elapsed else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }
