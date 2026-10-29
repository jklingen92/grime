"""Shared fixtures. Everything is generated in-process; no network or models."""

import io
import shutil

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import TestCase
from PIL import Image

from grime.models import Document, DocumentPage, Word, WorkerSlot


def png_bytes(size=(60, 40), color=(100, 150, 200), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


class GrimeTestCase(TestCase):
    def setUp(self):
        super().setUp()
        # Files written by a test must not leak into the next one.
        self.addCleanup(shutil.rmtree, settings.MEDIA_ROOT, ignore_errors=True)

    def make_staff(self):
        user = get_user_model().objects.create_user(
            "staff", password="pw", is_staff=True
        )
        self.client.force_login(user)
        return user

    def make_page(self, with_image=True, **kwargs) -> DocumentPage:
        doc = Document.objects.create(title="Doc")
        page = DocumentPage.objects.create(document=doc, page_number=1, **kwargs)
        if with_image:
            page.image.save("p.png", ContentFile(png_bytes()), save=True)
        return page

    def make_words(self, page, texts, line=0) -> list[Word]:
        return [
            Word.objects.create(
                page=page,
                line_num=line,
                word_num=i,
                left=i * 50,
                top=line * 20,
                width=40,
                height=15,
                conf=90,
                ocr_text=t,
            )
            for i, t in enumerate(texts)
        ]

    def make_slot(self, n=1) -> WorkerSlot:
        # A data migration already seeds the default slots.
        return WorkerSlot.objects.get_or_create(
            slot_number=n, defaults={"name": f"Slot {n}"}
        )[0]
