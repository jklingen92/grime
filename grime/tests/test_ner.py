"""NER tests. The HuggingFace pipeline is replaced by a canned-output callable."""

from unittest import mock

from grime.job_types import JOB_TYPES, NERParamsForm
from grime.models import AsyncJob, NERPass
from grime.pipeline import ner
from grime.tests.base import GrimeTestCase


def ent(group, word, start, end, score=0.99):
    return {
        "entity_group": group,
        "word": word,
        "start": start,
        "end": end,
        "score": score,
    }


class FakeNlp:
    """Looks each known name up in the paragraph, like a perfect tagger."""

    def __init__(self, vocab, score=0.99):
        self.vocab, self.score, self.calls = vocab, score, []

    def __call__(self, text):
        self.calls.append(text)
        out = []
        for name, group in self.vocab.items():
            i = text.find(name)
            if i != -1:
                out.append(ent(group, name, i, i + len(name), self.score))
        return sorted(out, key=lambda e: e["start"])


def patch_nlp(nlp):
    return mock.patch.object(ner, "_get_pipeline", return_value=nlp)


class ExtractEntitiesTests(GrimeTestCase):
    def test_blank_text_never_loads_a_model(self):
        with mock.patch.object(ner, "_get_pipeline") as gp:
            self.assertEqual(ner.extract_entities(""), [])
            self.assertEqual(ner.extract_entities("  \n "), [])
            gp.assert_not_called()

    def test_offsets_are_absolute_across_paragraphs(self):
        text = "John Smith met Anna.\n\nThen Paris."
        with patch_nlp(FakeNlp({"John Smith": "PER", "Paris": "LOC"})) as _:
            out = ner.extract_entities(text)
        self.assertEqual(
            [(e["entity_group"], text[e["start"] : e["end"]]) for e in out],
            [("PER", "John Smith"), ("LOC", "Paris")],
        )

    def test_filters_low_scores_and_unknown_groups(self):
        text = "Bob Acme Tuesday"
        nlp = mock.Mock(
            return_value=[
                ent("PER", "Bob", 0, 3, 0.5),
                ent("ORG", "Acme", 4, 8, 0.9),
                ent("MISC", "Tuesday", 9, 16, 0.99),
            ]
        )
        with patch_nlp(nlp):
            out = ner.extract_entities(text, confidence_threshold=0.8)
        self.assertEqual([e["word"] for e in out], ["Acme"])

    def test_inference_error_skips_only_that_paragraph(self):
        nlp = mock.Mock(side_effect=[RuntimeError("boom"), [ent("LOC", "Rome", 0, 4)]])
        text = "bad one\n\nRome is nice"
        with patch_nlp(nlp):
            out = ner.extract_entities(text)
        self.assertEqual(
            [(e["word"], e["start"]) for e in out], [("Rome", text.index("Rome"))]
        )


class ExtractPersonsTests(GrimeTestCase):
    def test_dedupes_and_drops_short_names_and_non_persons(self):
        nlp = mock.Mock(
            side_effect=[
                [
                    ent("PER", "Anna Lee", 0, 8),
                    ent("PER", "Al", 9, 11),
                    ent("LOC", "Rome", 12, 16),
                ],
                [ent("PER", "Anna Lee", 0, 8)],
            ]
        )
        with patch_nlp(nlp):
            out = ner.extract_persons("Anna Lee Al Rome\n\nAnna Lee")
        self.assertEqual([p["name"] for p in out], ["Anna Lee"])


class ModelRegistryTests(GrimeTestCase):
    def test_unknown_key_is_rejected(self):
        with self.assertRaises(ValueError):
            ner._resolve_model_path("nope")

    def test_known_key_resolves_to_hf_id(self):
        self.assertEqual(ner._resolve_model_path("fast"), ner.MODEL_REGISTRY["fast"])

    def test_pipeline_is_cached_per_key(self):
        ner.reload_pipeline()
        self.addCleanup(ner.reload_pipeline)
        ner._pipelines["fast"] = sentinel = object()
        self.assertIs(ner._get_pipeline("fast"), sentinel)
        ner.reload_pipeline("fast")
        self.assertNotIn("fast", ner._pipelines)


class LabelOcrWordsTests(GrimeTestCase):
    def test_bio_labels_follow_entity_spans(self):
        page = self.make_page()
        words = self.make_words(page, ["Met", "John", "Smith", "in", "Paris"])
        text = " ".join(w.text for w in words)
        entities = [
            {"entity_group": "PER", "start": 4, "end": 14},
            {"entity_group": "LOC", "start": 18, "end": 23},
        ]
        ner.label_ocr_words(words, text, entities)
        got = [w.ner_label for w in page.words.all()]
        self.assertEqual(got, [None, "B-PER", "I-PER", None, "B-LOC"])

    def test_corrected_text_drives_offsets(self):
        page = self.make_page()
        words = self.make_words(page, ["Jhn", "Smith"])
        words[0].corrected_text = "John"
        ner.label_ocr_words(
            words, "John Smith", [{"entity_group": "PER", "start": 5, "end": 10}]
        )
        self.assertEqual([w.ner_label for w in page.words.all()], [None, "B-PER"])

    def test_noop_without_entities_or_words(self):
        ner.label_ocr_words([], "x", [{"entity_group": "PER", "start": 0, "end": 1}])
        ner.label_ocr_words([object()], "x", [])


class NERJobTests(GrimeTestCase):
    def setUp(self):
        super().setUp()
        self.page = self.make_page(text="John Smith lives in Paris")
        self.words = self.make_words(
            self.page, ["John", "Smith", "lives", "in", "Paris"]
        )
        self.job = AsyncJob.objects.create(
            document=self.page.document,
            job_type="ner",
            status=AsyncJob.STATUS_RUNNING,
            params={"model": "fast"},
        )
        self.handler = JOB_TYPES["ner"]
        self.nlp = FakeNlp({"John Smith": "PER", "Paris": "LOC"})

    def run_job(self):
        with patch_nlp(self.nlp):
            self.handler.run(self.job)

    def test_run_labels_words_and_records_pass(self):
        self.run_job()
        self.assertEqual(
            [w.ner_label for w in self.page.words.all()],
            ["B-PER", "I-PER", None, None, "B-LOC"],
        )
        p = NERPass.objects.get(page=self.page)
        self.assertEqual(
            (p.schema_name, p.status), ("hf-ner-fast", NERPass.STATUS_COMPLETE)
        )
        self.assertEqual(self.page.words.filter(ner_pass=p).count(), 3)
        self.assertEqual(self.job.result, {"entities_found": 3})
        self.assertEqual((self.job.pages_done, self.job.pages_total), (1, 1))
        self.assertEqual(
            self.handler.results_summary(self.job),
            "NER'd 1 pages, 3 entities found (Fast)",
        )

    def test_already_processed_pages_are_skipped_unless_forced(self):
        self.run_job()
        self.nlp.calls.clear()
        self.run_job()
        self.assertEqual(self.nlp.calls, [])
        self.job.force = True
        self.run_job()
        self.assertEqual(len(self.nlp.calls), 1)
        self.assertEqual(
            NERPass.objects.filter(page=self.page).count(), 1
        )  # replaced, not duplicated

    def test_clean_removes_pass_and_labels(self):
        self.run_job()
        self.handler.clean(self.job)
        self.assertFalse(NERPass.objects.exists())
        self.assertFalse(self.page.words.exclude(ner_label=None).exists())

    def test_params_form_defaults_to_general(self):
        f = NERParamsForm({})
        self.assertTrue(f.is_valid())
        self.assertEqual(f.cleaned_data["model"], ner.DEFAULT_MODEL)
        self.assertFalse(NERParamsForm({"model": "bogus"}).is_valid())
