# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

## Setup

### Prerequisites

1. **Python 3.11+**
2. **uv** — Install from https://docs.astral.sh/uv/getting-started/installation/
3. **honcho** — installed automatically as part of the dev dependencies

### Installation

```bash
# Clone the repository
git clone https://github.com/jklingen92/grime.git
cd grime

# Install dependencies (creates .venv)
uv sync --extra dev

# Copy and configure environment variables
cp .env.example .env  # edit SECRET_KEY and any AWS/broker settings

# Run database migrations
python manage.py migrate   # also seeds WorkerSlot rows via post_migrate signal

# Create a superuser for the admin panel
python manage.py createsuperuser
```

### Running locally

Grime requires two processes: the Django web server and a Celery worker for
background OCR/NER jobs. Use honcho to start both at once:

```bash
honcho start
```

This reads the `Procfile` and starts:
- **web** — `python manage.py runserver` on http://127.0.0.1:8000
- **worker** — `celery -A demo.celery worker -l info`

Visit http://127.0.0.1:8000/admin and log in with your superuser credentials.

You can also start the processes separately if needed:

```bash
python manage.py runserver
celery -A demo.celery worker -l info
```

### Background jobs

OCR and NER can be triggered per-document from the document list page
(http://127.0.0.1:8000/). Each document has **OCR** and **NER** split-buttons:

- **OCR all** / **New pages only** — runs Tesseract (or Textract if configured) on every page or only pages without an existing OCR pass
- **NER all** / **New pages only** — runs the HF NER pipeline; the main button is disabled until all pages have been OCR'd

Job progress is shown inline with a live progress bar, polled every 3 seconds.
Completed and failed jobs display a dismissible badge.

The Celery broker uses a local SQLite file (`celery-broker.db`) by default —
no Redis or other external service is required. To use Redis in production,
set `CELERY_BROKER_URL=redis://...` in your `.env`.


## Management commands

You can also run OCR and NER page by page in the document viewer or bulk
process documents from the command line:

```bash
python manage.py ocr        --document 42 [--page N] [--textract] [--force] [--dry-run]
python manage.py ner        --document 42 [--page N] [--threshold 0.85] [--force] [--dry-run]
python manage.py match_tags --label "member entry" [--source-document 3] [--target-document 5] \
                            [--create-tags] [--force] [--min-score 0.5] [--tolerance 0.08]
```

