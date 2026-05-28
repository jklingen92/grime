from django.urls import include, path

from grime import viewer, views_jobs

app_name = "grime"

urlpatterns = [
    path("", viewer.document_list_view, name="document_list"),
    path("upload/", viewer.document_list_view, name="document_upload"),
    path("documents/<int:doc_pk>/", viewer.document_page_view, name="document"),
    path("documents/<int:doc_pk>/export/pdf/", viewer.export_document_pdf_view, name="document_export_pdf"),
    path("documents/<int:doc_pk>/rename/", viewer.rename_document_view, name="document_rename"),
    path("documents/<int:doc_pk>/delete/", viewer.delete_document_view, name="document_delete"),
    path(
        "documents/<int:doc_pk>/pages/<int:page_pk>/",
        viewer.document_page_view,
        name="document_page",
    ),
    path("pages/", include(viewer.get_viewer_urls())),
    # Job management
    path("jobs/", views_jobs.jobs_list_view, name="jobs_list"),
    path("jobs/create/", views_jobs.create_job, name="job_create"),
    path("jobs/form-fields/", views_jobs.job_form_fields, name="job_form_fields"),
    path("jobs/status/", views_jobs.jobs_status, name="jobs_status"),
    path("jobs/<int:job_pk>/cancel/", views_jobs.cancel_job, name="job_cancel"),
    path("jobs/<int:job_pk>/poll/", views_jobs.poll_job, name="job_poll"),
    path("jobs/<int:job_pk>/rerun/", views_jobs.rerun_job, name="job_rerun"),
    path("jobs/slots/<int:slot_number>/rename/", views_jobs.rename_worker_slot, name="worker_slot_rename"),
]
