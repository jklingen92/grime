# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

## Setup

### Prerequisites

1. **Python 3.11+**
2. **uv** — Install from https://docs.astral.sh/uv/getting-started/installation/

### Installation

```bash
# Clone the repository
git clone https://github.com/jklingen92/grime.git
cd grime

# Install dependencies (creates .venv)
uv sync --extra dev

# Run database migrations
uv run python manage.py migrate

# Create a superuser for the admin panel
uv run python manage.py createsuperuser

# Start the development server
uv run python manage.py runserver
```

Visit http://127.0.0.1:8000/admin and log in with your superuser credentials.

### Ingesting documents

```bash
uv run python manage.py ingest MY_DOCUMENT.pdf
# Returns an endpoint like /documents/1

# View the document
# http://127.0.0.1:8000/documents/1
```

## Management commands

You can run ocr and ner page by page in the document viewer or you can
bulk process documents from the command line using the following commands:

```bash
python manage.py ocr        --document 42 [--page N] [--textract] [--force] [--dry-run]
python manage.py ner        --document 42 [--page N] [--threshold 0.85] [--force] [--dry-run]
python manage.py match_tags --label "member entry" [--source-document 3] [--target-document 5] \
                            [--create-tags] [--force] [--min-score 0.5] [--tolerance 0.08]
```


## Status

This is an initial scaffold. The admin loads and the management commands
run end-to-end, but the embedded document viewer (`templates/admin/grime/_document_viewer.html`)
is read-only: bboxes and tags render on the page image, but interactive
editing (OCR correction, tag CRUD, NER label correction) needs AJAX
endpoints that have not been implemented yet.
