from django.urls import include, path

from grime import viewer, views, views_jobs

app_name = "grime"

urlpatterns = [
    path("", views.DocumentListView.as_view(), name="document_list"),
    path("upload/", views.DocumentListView.as_view(), name="document_upload"),
    path("documents/<int:doc_pk>/", views.DocumentPageView.as_view(), name="document"),
    path("documents/<int:doc_pk>/export/pdf/", views.ExportDocumentPdfView.as_view(), name="document_export_pdf"),
    path("documents/<int:doc_pk>/rename/", views.RenameDocumentView.as_view(), name="document_rename"),
    path("documents/<int:doc_pk>/delete/", views.DeleteDocumentView.as_view(), name="document_delete"),
    path(
        "documents/<int:doc_pk>/pages/<int:page_pk>/",
        views.DocumentPageView.as_view(),
        name="document_page",
    ),
    path("pages/", include(viewer.get_viewer_urls())),
    # Entity pages
    path("entities/", views.EntityListView.as_view(), name="entity_list"),
    path("entities/detail/", views.EntityDetailView.as_view(), name="entity_detail"),
    path("entities/note/", views.EntityNoteUpdateView.as_view(), name="entity_note_update"),
    path("entities/dismiss/", views.EntityDismissView.as_view(), name="entity_dismiss"),
    # Job management
    path("jobs/", views_jobs.JobsListView.as_view(), name="jobs_list"),
    path("jobs/create/", views_jobs.CreateJobView.as_view(), name="job_create"),
    path("jobs/form-fields/", views_jobs.JobFormFieldsView.as_view(), name="job_form_fields"),
    path("jobs/status/", views_jobs.JobsStatusView.as_view(), name="jobs_status"),
    path("jobs/<int:job_pk>/cancel/", views_jobs.CancelJobView.as_view(), name="job_cancel"),
    path("jobs/<int:job_pk>/poll/", views_jobs.PollJobView.as_view(), name="job_poll"),
    path("jobs/<int:job_pk>/rerun/", views_jobs.RerunJobView.as_view(), name="job_rerun"),
    path("jobs/slots/<int:slot_number>/rename/", views_jobs.RenameWorkerSlotView.as_view(), name="worker_slot_rename"),
]
