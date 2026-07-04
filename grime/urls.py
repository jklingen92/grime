from django.urls import include, path

from grime import viewer
from grime.views import base, jobs

app_name = "grime"

urlpatterns = [
    path("", base.DocumentListView.as_view(), name="document_list"),
    path("upload/", base.DocumentListView.as_view(), name="document_upload"),
    path("documents/<int:doc_pk>/", base.DocumentPageView.as_view(), name="document"),
    path(
        "documents/<int:doc_pk>/export/pdf/",
        base.ExportDocumentPdfView.as_view(),
        name="document_export_pdf",
    ),
    path(
        "documents/<int:doc_pk>/rename/",
        base.RenameDocumentView.as_view(),
        name="document_rename",
    ),
    path(
        "documents/<int:doc_pk>/delete/",
        base.DeleteDocumentView.as_view(),
        name="document_delete",
    ),
    path(
        "documents/<int:doc_pk>/pages/<int:page_pk>/",
        base.DocumentPageView.as_view(),
        name="document_page",
    ),
    path("pages/", include(viewer.get_viewer_urls())),
    # Entity pages
    path("entities/", base.EntityListView.as_view(), name="entity_list"),
    path("entities/detail/", base.EntityDetailView.as_view(), name="entity_detail"),
    path(
        "entities/note/", base.EntityNoteUpdateView.as_view(), name="entity_note_update"
    ),
    path("entities/dismiss/", base.EntityDismissView.as_view(), name="entity_dismiss"),
    # Job management
    path("jobs/", jobs.JobsListView.as_view(), name="jobs_list"),
    path("jobs/create/", jobs.CreateJobView.as_view(), name="job_create"),
    path("jobs/form-fields/", jobs.JobFormFieldsView.as_view(), name="job_form_fields"),
    path("jobs/status/", jobs.JobsStatusView.as_view(), name="jobs_status"),
    path("jobs/<int:job_pk>/cancel/", jobs.CancelJobView.as_view(), name="job_cancel"),
    path("jobs/<int:job_pk>/poll/", jobs.PollJobView.as_view(), name="job_poll"),
    path("jobs/<int:job_pk>/rerun/", jobs.RerunJobView.as_view(), name="job_rerun"),
    path(
        "jobs/slots/<int:slot_number>/rename/",
        jobs.RenameWorkerSlotView.as_view(),
        name="worker_slot_rename",
    ),
]
