"""OCR tests. Tesseract and Textract are faked at their boundaries."""

from unittest import mock

from PIL import Image

from grime.models import OCRPass, Word
from grime.pipeline import ocr, tesseract, textract
from grime.tests.base import GrimeTestCase


def tess_data(rows):
    """rows: (text, conf, block, par, line, left, top). Shape of pytesseract's DICT output."""
    cols = ["text", "conf", "block_num", "par_num", "line_num", "left", "top"]
    data = {c: [r[i] for r in rows] for i, c in enumerate(cols)}
    data["width"] = [30] * len(rows)
    data["height"] = [10] * len(rows)
    return data


class FakePytesseract:
    class Output:
        DICT = "dict"

    def __init__(self, data, text="hello world"):
        self.data, self.text = data, text
        self.sizes = []

    def image_to_data(self, img, config=None, output_type=None):
        self.sizes.append(img.size)
        return self.data

    def image_to_string(self, img, config=None):
        return self.text


def textract_response():
    def block(id_, type_, **kw):
        return {"Id": id_, "BlockType": type_, **kw}

    def geom(l, t, w, h):
        return {"BoundingBox": {"Left": l, "Top": t, "Width": w, "Height": h}}

    return {
        "Blocks": [
            block(
                "L1",
                "LINE",
                Text="Hello world",
                Relationships=[{"Type": "CHILD", "Ids": ["W1", "W2"]}],
            ),
            block(
                "W1",
                "WORD",
                Text="Hello",
                Confidence=99.0,
                Geometry=geom(0.1, 0.2, 0.3, 0.1),
            ),
            block(
                "W2",
                "WORD",
                Text="world",
                Confidence=97.0,
                Geometry=geom(0.5, 0.2, 0.0, 0.0),
            ),
            block("P", "PAGE"),
        ]
    }


def fake_preprocess(img):
    """Stands in for OpenCV preprocessing: same 2000px-wide upscale, no cv2 needed."""
    scale = 2000 / img.width
    return img.convert("L").resize((2000, int(img.height * scale)))


class PreprocessTests(GrimeTestCase):
    def test_upscales_and_binarizes(self):
        try:
            import cv2  # noqa: F401  (needs libGL, absent on some headless boxes)
        except ImportError as exc:
            self.skipTest(f"OpenCV unavailable: {exc}")
        out = tesseract.preprocess(Image.new("RGB", (500, 100), (255, 255, 255)))
        self.assertEqual(out.width, 2000)
        self.assertEqual(out.mode, "L")
        self.assertLessEqual(set(out.getdata()), {0, 255})

    def test_visual_content_detection(self):
        text_like = Image.new("L", (100, 100), 255)
        text_like.paste(0, (0, 0, 100, 10))
        photo = Image.linear_gradient("L")
        self.assertFalse(tesseract.is_visual_content(text_like))
        self.assertTrue(tesseract.is_visual_content(photo))


class TesseractOcrTests(GrimeTestCase):
    def run_ocr(self, data, size=(1000, 500)):
        fake = FakePytesseract(data)
        with (
            mock.patch.dict("sys.modules", {"pytesseract": fake}),
            mock.patch.object(tesseract, "preprocess", fake_preprocess),
        ):
            return tesseract.ocr_image(Image.new("RGB", size, "white")), fake

    def test_flattens_to_lines_sorted_top_to_bottom(self):
        data = tess_data(
            [
                ("", -1, 1, 1, 1, 0, 0),  # structural row, dropped
                ("second", 80, 1, 1, 2, 100, 200),
                ("b", 60, 1, 1, 1, 200, 50),
                ("a", 90, 1, 1, 1, 100, 50),
                ("   ", 95, 1, 1, 1, 300, 50),  # whitespace-only, dropped
            ]
        )
        (text, conf, words), _ = self.run_ocr(data)
        self.assertEqual(text, "hello world")
        self.assertEqual(conf, 81.2)  # whitespace-only rows still count toward the mean
        self.assertEqual(
            [(w["text"], w["line_num"], w["word_num"]) for w in words],
            [("a", 0, 0), ("b", 0, 1), ("second", 1, 0)],
        )

    def test_boxes_are_scaled_back_to_original_pixels(self):
        # 1000px wide input is upscaled 2x for tesseract; coordinates must come back.
        (_, _, words), fake = self.run_ocr(tess_data([("a", 90, 1, 1, 1, 200, 100)]))
        self.assertEqual(fake.sizes[0][0], 2000)
        self.assertEqual(
            (words[0]["left"], words[0]["top"], words[0]["width"]), (100, 50, 15)
        )

    def test_no_words_gives_zero_confidence(self):
        (_, conf, words), _ = self.run_ocr(tess_data([("", -1, 1, 1, 1, 0, 0)]))
        self.assertEqual((conf, words), (0.0, []))


class TextractTests(GrimeTestCase):
    def test_parses_blocks_to_pixel_words(self):
        client = mock.Mock()
        client.detect_document_text.return_value = textract_response()
        text, conf, words = textract.textract_page(Image.new("RGB", (200, 100)), client)
        self.assertEqual(text, "Hello world")
        self.assertEqual(conf, 98.0)
        self.assertEqual(
            words[0],
            {
                "line_num": 0,
                "word_num": 0,
                "left": 20,
                "top": 20,
                "width": 60,
                "height": 10,
                "conf": 99.0,
                "text": "Hello",
            },
        )
        self.assertEqual(
            (words[1]["width"], words[1]["height"]), (1, 1)
        )  # clamped to >=1
        self.assertIn("Document", client.detect_document_text.call_args.kwargs)

    def test_empty_response(self):
        client = mock.Mock()
        client.detect_document_text.return_value = {}
        self.assertEqual(
            textract.textract_page(Image.new("RGB", (10, 10)), client), ("", 0.0, [])
        )


class DispatchTests(GrimeTestCase):
    img = Image.new("RGB", (10, 10))
    result = ("t", 80.0, [])

    def test_rejects_unknown_engine(self):
        with self.assertRaises(ValueError):
            ocr.dispatch(self.img, engine="magic")

    def test_auto_prefers_textract(self):
        with (
            mock.patch("grime.pipeline.textract.make_client"),
            mock.patch(
                "grime.pipeline.textract.textract_page", return_value=self.result
            ),
        ):
            self.assertEqual(ocr.dispatch(self.img)[3], "textract")

    def test_auto_falls_back_to_tesseract(self):
        with (
            mock.patch(
                "grime.pipeline.textract.make_client",
                side_effect=RuntimeError("no creds"),
            ),
            mock.patch(
                "grime.pipeline.tesseract.ocr_image", return_value=self.result
            ) as t,
        ):
            self.assertEqual(ocr.dispatch(self.img)[3], "tesseract")
            t.assert_called_once()

    def test_explicit_textract_surfaces_errors(self):
        with (
            mock.patch(
                "grime.pipeline.textract.make_client",
                side_effect=RuntimeError("no creds"),
            ),
            self.assertRaises(RuntimeError),
        ):
            ocr.dispatch(self.img, engine="textract")

    def test_explicit_tesseract_skips_textract(self):
        with (
            mock.patch("grime.pipeline.textract.make_client") as mk,
            mock.patch("grime.pipeline.tesseract.ocr_image", return_value=self.result),
        ):
            ocr.dispatch(self.img, engine="tesseract")
            mk.assert_not_called()


def fake_dispatch(words, text="Hello world"):
    return mock.patch.object(
        ocr, "dispatch", return_value=(text, 91.0, words, "tesseract")
    )


def w(text, left, top=0, line=0, num=0):
    return {
        "text": text,
        "left": left,
        "top": top,
        "width": 30,
        "height": 10,
        "conf": 90.0,
        "line_num": line,
        "word_num": num,
    }


class RunPageTests(GrimeTestCase):
    def test_persists_pass_words_and_text(self):
        page = self.make_page()
        with fake_dispatch(
            [w("world", 100, num=1), w("Hello", 0, num=0)], text=" Hello world \n"
        ):
            ocr_pass = ocr.run_page(page, engine="tesseract")
        page.refresh_from_db()
        self.assertEqual(page.text, "Hello world")
        self.assertEqual(
            (ocr_pass.method, ocr_pass.confidence, ocr_pass.status),
            ("tesseract", 91.0, OCRPass.STATUS_COMPLETE),
        )
        self.assertEqual([x.ocr_text for x in page.words.all()], ["Hello", "world"])

    def test_skips_without_image_or_for_manual_text(self):
        with fake_dispatch([]) as d:
            self.assertIsNone(ocr.run_page(self.make_page(with_image=False)))
            self.assertIsNone(ocr.run_page(self.make_page(text_source="manual")))
            d.assert_not_called()

    def test_force_overrides_manual_text_source(self):
        with fake_dispatch([w("x", 0)]):
            self.assertIsNotNone(
                ocr.run_page(self.make_page(text_source="embedded"), force=True)
            )

    def test_post_ocr_renumbers_lines_by_position(self):
        page = self.make_page()
        # Engine reports everything as line 0; geometry says two lines.
        words = [
            w("top", 0, top=0, num=0),
            w("bottom", 0, top=60, num=1),
            w("right", 100, top=0, num=2),
        ]
        with fake_dispatch(words):
            ocr.run_page(page)
        got = [(x.ocr_text, x.line_num, x.word_num) for x in page.words.all()]
        self.assertEqual(got, [("top", 0, 0), ("right", 0, 1), ("bottom", 1, 0)])

    def test_ditto_marks_are_resolved(self):
        page = self.make_page()
        words = [w("Smith", 0, top=0), w('"', 0, top=30, line=1)]
        with fake_dispatch(words):
            ocr.run_page(page)
        ditto = page.words.get(is_ditto=True)
        self.assertEqual(ditto.corrected_text, "Smith")


class RerunSelectionTests(GrimeTestCase):
    def test_replaces_selected_words_with_translated_boxes(self):
        page = self.make_page()
        # Separate lines: re-OCR numbers new words from 0 on the inherited line,
        # so a surviving neighbour on the same line would collide (see follow-up issue).
        a = self.make_words(page, ["foo"], line=0)[0]
        b = self.make_words(page, ["bar"], line=1)[0]
        Word.objects.filter(pk=b.pk).update(left=20)
        b.refresh_from_db()
        with fake_dispatch([w("baz", 3, top=2)]):
            out = ocr.rerun_selection(page, [b.pk])
        self.assertEqual(out["deleted_ids"], [b.pk])
        new = out["new_words"][0]
        # crop origin = word left - 4px padding (clamped at 0)
        self.assertEqual((new.ocr_text, new.left), ("baz", b.left - 4 + 3))
        self.assertTrue(Word.objects.filter(pk=a.pk).exists())

    def test_empty_selection_redoes_whole_page(self):
        page = self.make_page()
        self.make_words(page, ["foo", "bar"])
        with fake_dispatch([w("only", 0)]):
            ocr.rerun_selection(page, [])
        self.assertEqual([x.ocr_text for x in page.words.all()], ["only"])

    def test_errors(self):
        with self.assertRaises(ValueError):
            ocr.rerun_selection(self.make_page(with_image=False), [])
        with self.assertRaises(ValueError):
            ocr.rerun_selection(self.make_page(), [12345])
