from django import forms


class CreateJobForm(forms.Form):
    """Outer form for the Add Job modal (job type + document + worker slot + force)."""

    job_type = forms.ChoiceField(
        widget=forms.Select(attrs={"class": "form-select form-select-sm", "id": "id_job_type"}),
    )
    document = forms.IntegerField(widget=forms.HiddenInput())
    worker_slot = forms.IntegerField(
        widget=forms.Select(attrs={"class": "form-select form-select-sm"}),
    )
    force = forms.BooleanField(
        required=False,
        label="Force (reprocess all pages)",
        widget=forms.CheckboxInput(attrs={"class": "form-check-input"}),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        from grime.job_types import JOB_TYPES
        from grime.models import Document, WorkerSlot

        self.fields["job_type"].choices = [(k, h.label) for k, h in JOB_TYPES.items()]
        self.fields["document"].widget = forms.Select(
            attrs={"class": "form-select form-select-sm"},
            choices=[("", "— select —")]
            + [(d.pk, d.title) for d in Document.objects.order_by("title")],
        )
        self.fields["worker_slot"].widget = forms.Select(
            attrs={"class": "form-select form-select-sm"},
            choices=[(s.pk, s.name) for s in WorkerSlot.objects.all()],
        )


class DocumentUploadForm(forms.Form):
    pdf_file = forms.FileField(
        label="PDF file",
        help_text="Single PDF to ingest as a new document.",
    )
    title = forms.CharField(
        max_length=1000,
        required=False,
        label="Title",
        help_text="Optional — defaults to the filename.",
    )

    def clean_pdf_file(self):
        f = self.cleaned_data["pdf_file"]
        if not f.name.lower().endswith(".pdf"):
            raise forms.ValidationError("Only PDF files are accepted.")
        return f
