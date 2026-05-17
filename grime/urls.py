from django.urls import include, path

from grime import viewer

app_name = "grime"

urlpatterns = [
    path("", viewer.document_list_view, name="document_list"),
    path("upload/", viewer.document_list_view, name="document_upload"),
    path("documents/<int:doc_pk>/", viewer.document_page_view, name="document"),
    path(
        "documents/<int:doc_pk>/pages/<int:page_pk>/",
        viewer.document_page_view,
        name="document_page",
    ),
    path("pages/", include(viewer.get_viewer_urls())),
    path("documents/<int:doc_pk>/jobs/ocr/", viewer.trigger_ocr_job, name="document_jobs_ocr"),
    path("documents/<int:doc_pk>/jobs/ner/", viewer.trigger_ner_job, name="document_jobs_ner"),
    path("jobs/status/", viewer.jobs_status, name="jobs_status"),
]
