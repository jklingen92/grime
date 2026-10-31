import json

from django.urls import reverse
from PIL import Image

from grime import viewer
from grime.tests.base import GrimeTestCase

DEFAULTS = viewer._DEFAULT_IMAGE_PARAMS


def adjust(im, **patch):
    return viewer._apply_image_adjustments(im, {**DEFAULTS, **patch})


class LutTests(GrimeTestCase):
    def test_identity(self):
        self.assertEqual(viewer._build_image_lut(DEFAULTS), list(range(256)))

    def test_levels_clamp(self):
        lut = viewer._build_image_lut({**DEFAULTS, "black": 50, "white": 200})
        self.assertEqual((lut[0], lut[50], lut[200], lut[255]), (0, 0, 255, 255))

    def test_brightness_and_contrast(self):
        self.assertEqual(
            viewer._build_image_lut({**DEFAULTS, "brightness": 1.0})[0], 255
        )
        flat = viewer._build_image_lut({**DEFAULTS, "contrast": 0.0})
        self.assertEqual(set(flat), {128})

    def test_gamma_brightens_midtones(self):
        self.assertGreater(
            viewer._build_image_lut({**DEFAULTS, "gamma": 2.0})[128], 128
        )

    def test_white_never_at_or_below_black(self):
        lut = viewer._build_image_lut({**DEFAULTS, "black": 100, "white": 50})
        self.assertEqual(len(lut), 256)  # no ZeroDivisionError


class ApplyAdjustmentsTests(GrimeTestCase):
    def solid(self, value=100, mode="RGB"):
        color = (
            value
            if mode == "L"
            else (value,) * 3 if mode == "RGB" else (value,) * 3 + (77,)
        )
        return Image.new(mode, (20, 10), color)

    def test_identity_keeps_pixels(self):
        self.assertEqual(adjust(self.solid()).getpixel((0, 0)), (100, 100, 100))

    def test_invert(self):
        self.assertEqual(adjust(self.solid(), invert=True).getpixel((0, 0)), (155,) * 3)

    def test_invert_preserves_alpha(self):
        out = adjust(self.solid(mode="RGBA"), invert=True)
        self.assertEqual(out.getpixel((0, 0)), (155, 155, 155, 77))

    def test_grayscale_makes_channels_equal(self):
        out = adjust(Image.new("RGB", (4, 4), (255, 0, 0)), grayscale=True)
        r, g, b = out.getpixel((0, 0))
        self.assertTrue(r == g == b)

    def test_threshold_binarizes(self):
        self.assertEqual(
            adjust(self.solid(200), threshold=128).getpixel((0, 0)), (255,) * 3
        )
        self.assertEqual(
            adjust(self.solid(50), threshold=128).getpixel((0, 0)), (0,) * 3
        )

    def test_rotate90_swaps_dimensions_clockwise(self):
        im = Image.new("RGB", (20, 10), (255, 255, 255))
        im.putpixel((0, 0), (0, 0, 0))  # top-left
        out = adjust(im, rotate90=1)
        self.assertEqual(out.size, (10, 20))
        self.assertEqual(
            out.getpixel((9, 0)), (0, 0, 0)
        )  # clockwise: top-left -> top-right

    def test_fine_rotation_expands_canvas(self):
        self.assertGreater(adjust(self.solid(), rotate_fine=5.0).width, 20)

    def test_sharpen_keeps_size_and_mode(self):
        out = adjust(self.solid(), sharpen=True)
        self.assertEqual((out.size, out.mode), ((20, 10), "RGB"))

    def test_unsupported_mode_is_converted(self):
        self.assertEqual(adjust(Image.new("P", (4, 4))).mode, "RGB")


class ImageEndpointTests(GrimeTestCase):
    def setUp(self):
        super().setUp()
        self.make_staff()
        self.page = self.make_page()

    def url(self, name):
        return reverse(
            f"grime:grime_documentpage_viewer_image_{name}", args=[self.page.pk]
        )

    def post(self, name, body=None):
        return self.client.post(
            self.url(name), json.dumps(body or {}), content_type="application/json"
        )

    def test_save_bakes_corrected_image(self):
        res = self.post("save", {"invert": True})
        self.assertEqual(res.status_code, 200)
        self.page.refresh_from_db()
        self.assertTrue(self.page.corrected_image.name.endswith("-corrected.png"))
        self.assertTrue(self.page.image_adjustments["invert"])
        self.assertEqual(self.page.corrected_image_by.username, "staff")
        with Image.open(self.page.corrected_image.path) as im:
            self.assertEqual(im.getpixel((0, 0)), (155, 105, 55))

    def test_save_twice_keeps_latest_adjustments(self):
        self.post("save", {"invert": True})
        self.post("save", {"grayscale": True})
        self.page.refresh_from_db()
        self.assertTrue(self.page.image_adjustments["grayscale"])
        self.assertFalse(self.page.image_adjustments["invert"])
        with Image.open(self.page.corrected_image.path) as im:
            self.assertEqual(len(set(im.convert("RGB").getpixel((0, 0)))), 1)

    def test_save_rejects_bad_json_and_missing_image(self):
        res = self.client.post(
            self.url("save"), "{nope", content_type="application/json"
        )
        self.assertEqual(res.status_code, 400)
        bare = self.make_page(with_image=False)
        res = self.client.post(
            reverse("grime:grime_documentpage_viewer_image_save", args=[bare.pk]),
            "{}",
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)

    def test_unknown_page_is_404(self):
        res = self.client.post(
            reverse("grime:grime_documentpage_viewer_image_save", args=[9999]),
            "{}",
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 404)

    def test_get_not_allowed(self):
        self.assertEqual(self.client.get(self.url("save")).status_code, 405)

    def test_reset_drops_corrected_image(self):
        self.post("save", {"invert": True})
        res = self.post("reset")
        self.assertEqual(res.status_code, 200)
        self.page.refresh_from_db()
        self.assertFalse(self.page.corrected_image)
        self.assertIsNone(self.page.image_adjustments)
        self.assertEqual(res.json()["image_url"], self.page.image.url)

    def test_autocontrast_flat_image_returns_valid_range(self):
        data = self.post("autocontrast").json()
        self.assertTrue(data["ok"])
        self.assertLess(data["black"], data["white"])

    def test_autocontrast_finds_histogram_bounds(self):
        # 50% value 20, 50% value 220: 1% cutoffs land on those two values.
        im = Image.new("L", (100, 100), 20)
        im.paste(220, (0, 50, 100, 100))
        im.save(self.page.image.path)
        data = self.post("autocontrast").json()
        self.assertEqual((data["black"], data["white"]), (20, 220))
