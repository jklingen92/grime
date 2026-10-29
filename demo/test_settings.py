"""
Settings for the test suite: no .env, in-memory DB, throwaway MEDIA_ROOT.

    python manage.py test --settings=demo.test_settings
"""

import os
import tempfile

os.environ.setdefault("SECRET_KEY", "test-only-secret")

from demo.settings import *  # noqa: E402,F401,F403

DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
MEDIA_ROOT = tempfile.mkdtemp(prefix="grime-test-media-")
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
