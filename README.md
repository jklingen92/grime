# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

## Models

| Model          | Role |
|----------------|------|
| `Document`     | A standalone archival document (PDF, scanned booklet, ledger). |
| `DocumentPage` | A single page of a Document — the unit of OCR processing. |
| `Word`         | One OCR-extracted word on a DocumentPage, with bbox, confidence, optional human correction, and optional BIO NER label. |
| `Tag`          | A manually drawn region on a Document or DocumentPage with a label and word-level subcomponents. |
| `OCRPass`      | Audit record for one OCR run on a DocumentPage. |
| `NERPass`      | Audit record for one NER run on a DocumentPage. |

## Management commands

```bash
python manage.py ocr        --document 42 [--page N] [--textract] [--force] [--dry-run]
python manage.py ner        --document 42 [--page N] [--threshold 0.85] [--force] [--dry-run]
python manage.py match_tags --label "member entry" [--source-document 3] [--target-document 5] \
                            [--create-tags] [--force] [--min-score 0.5] [--tolerance 0.08]
```

## Quick start

```bash
pip install -e ".[dev]"
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
# then visit http://127.0.0.1:8000/admin/
```

## Optional dependencies

| Extra      | Adds                                          |
|------------|-----------------------------------------------|
| `ocr`      | Tesseract (`pytesseract`, `opencv-python`, `numpy`) |
| `textract` | AWS Textract via `boto3`                      |
| `hf`       | HuggingFace historical NER (`transformers`, `torch`) |
| `viz`      | `match_tags --video` rendering (`imageio[ffmpeg]`) |
| `dev`      | All of the above                              |

System prerequisites for the `ocr` extra:

```bash
sudo apt install tesseract-ocr poppler-utils
```

## Status

This is an initial scaffold. The admin loads and the management commands
run end-to-end, but the embedded document viewer (`templates/admin/grime/_document_viewer.html`)
is read-only: bboxes and tags render on the page image, but interactive
editing (OCR correction, tag CRUD, NER label correction) needs AJAX
endpoints that have not been implemented yet.
