# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

## Setup

### Prerequisites

1. **Python 3.11+**
2. **Node.js 18+** and **npm** — for the React frontend build
3. **uv** — Install from https://docs.astral.sh/uv/getting-started/installation/
4. **honcho** — installed automatically as part of the dev dependencies

### Installation

```bash
# Clone the repository
git clone https://github.com/jklingen92/grime.git
cd grime

# Install Python dependencies (creates .venv)
uv sync

# Install JavaScript dependencies and build the frontend
npm install
npm run build

# Copy and configure environment variables
cp .env.example .env  # edit SECRET_KEY and any AWS/broker settings

# Run database migrations
python manage.py migrate   # also seeds WorkerSlot rows via post_migrate signal

# Create a superuser for the admin panel
python manage.py createsuperuser
```

### Running locally

Use honcho to start all processes at once:

```bash
honcho start
```

This reads the `Procfile` and starts:
- **web** — `python manage.py runserver` on http://127.0.0.1:8000
- **worker1/2/3** — `python manage.py run_worker --slot=N` (DB-polling background workers)
- **js** — `npm run dev` (Vite watch build for the React frontend)

Visit http://127.0.0.1:8000 and log in with your superuser credentials.

You can also start processes individually:

```bash
python manage.py runserver
python manage.py run_worker --slot=1
npm run dev   # rebuilds frontend/src/ on change
```

### Background jobs

OCR and NER jobs are queued from the document list or viewer and processed by
the `run_worker` management command. Job progress is shown live in the Workers
panel, polled every 3 seconds.

## Frontend

Interactive UI components use React, built with Vite. Source lives in
`frontend/src/`; built output is committed to `grime/static/grime/` so no
build step is required to run the project after cloning (the built files are
already present).

To rebuild after editing React source:

```bash
npm run build        # one-shot build
npm run dev          # watch mode — rebuilds on every save
```

The `js` process in the `Procfile` runs watch mode automatically when you
use `honcho start`.


## Management commands

You can also run OCR and NER page by page in the document viewer or bulk
process documents from the command line:

```bash
python manage.py ocr        --document 42 [--page N] [--textract] [--force] [--dry-run]
python manage.py ner        --document 42 [--page N] [--threshold 0.85] [--force] [--dry-run]
python manage.py match_tags --label "member entry" [--source-document 3] [--target-document 5] \
                            [--create-tags] [--force] [--min-score 0.5] [--tolerance 0.08]
```

