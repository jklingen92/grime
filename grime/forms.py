from django import forms


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
