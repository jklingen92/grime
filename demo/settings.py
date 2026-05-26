"""
Minimal Django project that hosts the `grime` reusable app for local development.

Run `python manage.py migrate && python manage.py createsuperuser && python manage.py runserver`,
then visit http://127.0.0.1:8000/admin/.
"""

from pathlib import Path
import environ

env = environ.Env(
    DEBUG=(bool, False),
)

BASE_DIR = Path(__file__).resolve().parent.parent

environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("SECRET_KEY")
DEBUG = env("DEBUG")
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "grime",
    "django.contrib.staticfiles",
    "django_extensions",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "demo.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "demo.wsgi.application"
ASGI_APPLICATION = "demo.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# AWS
AWS_ACCESS_KEY_ID = env("AWS_ACCESS_KEY_ID", default="")
AWS_SECRET_ACCESS_KEY = env("AWS_SECRET_ACCESS_KEY", default="")
AWS_DEFAULT_REGION = env("AWS_DEFAULT_REGION", default="us-east-1")

# Celery — uses a local SQLite file as broker (no Redis required for local dev).
# Override CELERY_BROKER_URL in .env to switch to Redis in production.
CELERY_BROKER_URL = env(
    "CELERY_BROKER_URL",
    default=f"sqla+sqlite:///{BASE_DIR / 'celery-broker.db'}",
)
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TIMEZONE = TIME_ZONE
# We track job state in AsyncJob, so Celery's result backend is unused.
# Disabling it prevents connection errors when Redis is only used as a broker.
CELERY_TASK_IGNORE_RESULT = True

# Number of named worker slots. Each slot gets its own Celery queue and process.
# Update Procfile to match when changing this value, then run seed_worker_slots.
GRIME_WORKER_SLOTS = env.int("GRIME_WORKER_SLOTS", default=3)
