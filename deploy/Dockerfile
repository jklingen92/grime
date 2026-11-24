# Production image for the demo project: gunicorn (web) and run_worker (workers).
# Built from the repo root by deploy/compose.yaml:
#   docker compose -f deploy/compose.yaml build
FROM python:3.12-slim

# tesseract for OCR, poppler for pdf2image, libglib for opencv-headless.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Dependencies first so code-only changes reuse this (multi-GB, torch) layer.
# Frontend is prebuilt into grime/static/grime/, so no Node here.
ARG UV_SYNC="uv sync --frozen --no-default-groups --group prod --extra ocr --extra hf --extra textract"
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN $UV_SYNC --no-install-project

COPY . .
RUN $UV_SYNC

# Process commands (gunicorn, run_worker) are set per service in compose.yaml.
