# grime

Grime is an archival document management platform — a reusable Django app
for ingesting scanned documents, running OCR / NER pipelines, and annotating
pages with tagged regions.

## Setup

### Prerequisites

1. **Python 3.11+**
2. **Node.js 18+** and **npm** — for the React frontend build
3. **uv** — Install from https://docs.astral.sh/uv/getting-started/installation/

### Installation

```bash
# Clone the repository
git clone https://github.com/jklingen92/grime.git
cd grime

# Install Python dependencies, including the dev group (creates .venv)
uv sync --group dev
source .venv/bin/activate

# Install the git pre-commit hooks (black)
pre-commit install

# Install JavaScript dependencies and build the frontend
npm install
npm run build

# Copy and configure environment variables
cp .env.example .env  # edit SECRET_KEY and any AWS/broker settings

# Start the dev Postgres container (matches DATABASE_URL in .env.example)
docker compose -f deploy/compose.dev.yaml up -d

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


## Deployment

`deploy/` runs the demo project in Docker Compose: Postgres, gunicorn, one
GPU worker per slot, and Caddy serving static/media. Caddy binds only to the
host's ZeroTier IP (`BIND_IP`), so the app is reachable only by devices
authorized on the ZeroTier network. The prod stack (`grime-prod`) is separate
from the dev Postgres (`grime-dev`, `deploy/compose.dev.yaml`).

### Host setup (once)

The host needs Docker, ZeroTier, and the NVIDIA container toolkit so workers
can use the GPU for NER.

```bash
# Let your user talk to Docker (root-equivalent); start a fresh login after,
# since existing shells and tmux servers keep the old groups.
sudo usermod -aG docker $USER

# NVIDIA container toolkit (from NVIDIA's install docs)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# The host's ZeroTier IP goes in BIND_IP and ALLOWED_HOSTS
sudo zerotier-cli listnetworks
```

### First deploy

```bash
cp deploy/.env.example deploy/.env       # fill in SECRET_KEY, POSTGRES_PASSWORD, BIND_IP, ALLOWED_HOSTS
docker compose -f deploy/compose.yaml up -d --build    # first build pulls torch/CUDA (several GB)
docker compose -f deploy/compose.yaml run --rm web python manage.py migrate
docker compose -f deploy/compose.yaml run --rm web python manage.py createsuperuser
```

Workers crash-loop until `migrate` has run, then recover on their own.
Visit `http://<zerotier-ip>:8080`.

### Checks

```bash
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail 50 worker1
# Workers see the GPU; prints True
docker compose -f deploy/compose.yaml exec worker1 python -c "import torch; print(torch.cuda.is_available())"
```

### Deploying new code

```bash
git pull
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml run --rm web python manage.py migrate
```

### Adding a user

1. They install ZeroTier and join the network ID.
2. Authorize their device in ZeroTier Central (my.zerotier.com → network → Members).
3. Create a regular (non-superuser) account at `http://<zerotier-ip>:8080/admin/`.
4. They open `http://<zerotier-ip>:8080`, typing the `http://`; there's no HTTPS.

On a Chromebook, ZeroTier must be on in the ChromeOS app (VPN icon by the
clock). ZeroTier inside the Linux container doesn't route Chrome's traffic.


## Management commands

You can also run OCR and NER page by page in the document viewer or bulk
process documents from the command line:

```bash
python manage.py ocr        --document 42 [--page N] [--textract] [--force] [--dry-run]
python manage.py ner        --document 42 [--page N] [--threshold 0.85] [--force] [--dry-run]
python manage.py match_tags --label "member entry" [--source-document 3] [--target-document 5] \
                            [--create-tags] [--force] [--min-score 0.5] [--tolerance 0.08]
```

