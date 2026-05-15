"""
HuggingFace NER pipeline for historical newspaper text.

Uses ``dell-research-harvard/historical_newspaper_ner``, a transformer model
fine-tuned on historical American OCR'd newspaper text.

Published F1 scores on the test set: PER=94.3, ORG=80.7, LOC=90.8, Overall=86.5

The model is loaded once and cached in-process. First call will download the
model weights (~440 MB) and cache them in the HuggingFace hub cache directory.

Usage::

    from pipeline.hf_ner import extract_persons

    persons = extract_persons(article.text)
    # [{"name": "John Smith", "score": 0.97}, ...]

Requires the ``[hf]`` optional dependencies::

    pip install -e ".[hf]"
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

MODEL_NAME = "dell-research-harvard/historical_newspaper_ner"
DEFAULT_CONFIDENCE_THRESHOLD = 0.80

# Fine-tuned model directory — written by `train_model --type hf-ner`.
# If it exists and contains model files, it is loaded instead of the base model.
_FINE_TUNED_PATH = (
    Path(__file__).resolve().parent.parent / "models" / "hf_ner_finetuned"
)

# Module-level cache — loaded once per process.
_pipeline = None


def _resolve_model_path() -> str:
    """Return the fine-tuned model path if available, else the base model name."""
    if _FINE_TUNED_PATH.exists() and any(_FINE_TUNED_PATH.iterdir()):
        logger.info("Loading fine-tuned HF NER model from %s", _FINE_TUNED_PATH)
        return str(_FINE_TUNED_PATH)
    return MODEL_NAME


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        try:
            from transformers import (
                AutoModelForTokenClassification,
                AutoTokenizer,
                pipeline,
            )
        except ImportError as exc:
            raise ImportError(
                "HuggingFace NER requires the [hf] optional dependencies. "
                "Install with: pip install -e '.[hf]'"
            ) from exc

        model_path = _resolve_model_path()
        tokenizer = AutoTokenizer.from_pretrained(model_path)
        model = AutoModelForTokenClassification.from_pretrained(model_path)
        _pipeline = pipeline(
            "ner",
            model=model,
            tokenizer=tokenizer,
            aggregation_strategy="simple",
        )
    return _pipeline


def reload_pipeline():
    """
    Force the pipeline to reload on next call.

    Call this after running ``train_model --type hf-ner`` if you want
    the fine-tuned model to be used in the current process without restarting.
    """
    global _pipeline
    _pipeline = None


def extract_entities(
    text: str,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> list[dict]:
    """
    Extract all named entities (PER, LOC, ORG) from text, returning character offsets
    relative to the full input text.

    Processes text in paragraphs (same 512-token window handling as extract_persons) and
    tracks cumulative offsets so spans are absolute positions into ``text``.

    Returns a list of dicts with:
      - ``entity_group``: "PER", "LOC", or "ORG"
      - ``start``: character start offset in ``text``
      - ``end``: character end offset in ``text``
      - ``word``: extracted span string
      - ``score``: mean model confidence (0.0–1.0)

    Does not deduplicate — character positions are needed for OCRWord mapping.
    """
    import re

    if not text or not text.strip():
        return []

    nlp = _get_pipeline()
    results = []
    offset = 0

    for para in re.split(r"\n\s*\n", text):
        if not para.strip():
            para_len = len(para) + 2  # approx blank line gap
            offset += para_len
            continue
        # find where this paragraph starts in the original text
        para_start = text.find(para, offset)
        if para_start == -1:
            para_start = offset
        try:
            entities = nlp(para)
        except Exception as exc:
            logger.error("HF NER inference failed on paragraph: %s", exc)
            offset = para_start + len(para) + 2
            continue
        for ent in entities:
            if ent["entity_group"] not in ("PER", "LOC", "ORG"):
                continue
            score = float(ent["score"])
            if score < confidence_threshold:
                continue
            results.append(
                {
                    "entity_group": ent["entity_group"],
                    "start": para_start + ent["start"],
                    "end": para_start + ent["end"],
                    "word": ent["word"].strip(),
                    "score": round(score, 4),
                }
            )
        offset = para_start + len(para) + 2

    return results


def label_ocr_words(words: list, text: str, entities: list[dict]) -> None:
    """
    Assign BIO NER labels to OCRWord instances based on entity spans.

    Reconstructs text from ``words`` in reading order (using corrected_text where
    available), maps entity character offsets to individual words, and bulk-saves
    ``ner_label`` on matching words. Words that fall outside all entity spans are
    left with ``ner_label=None`` (O tokens).

    ``words`` must be OCRWord model instances (not dicts). Caller is responsible
    for passing words belonging to a single source in reading order.
    """
    if not words or not entities:
        return

    # Reconstruct text with per-word character offset tracking
    word_spans: list[tuple[int, int, object]] = []
    pos = 0
    for w in words:
        t = (w.corrected_text if w.corrected_text is not None else w.text) or ""
        word_spans.append((pos, pos + len(t), w))
        pos += len(t) + 1  # +1 for space separator

    # Assign labels; later entities overwrite earlier ones for overlapping words
    updates: list = []
    for ent in entities:
        ent_start, ent_end, entity_group = ent["start"], ent["end"], ent["entity_group"]
        overlapping = [
            (i, w_start, w_end, w)
            for i, (w_start, w_end, w) in enumerate(word_spans)
            if w_start < ent_end and w_end > ent_start
        ]
        for seq_idx, (_, _, _, word) in enumerate(overlapping):
            label = ("B-" if seq_idx == 0 else "I-") + entity_group
            word.ner_label = label
            updates.append(word)

    if updates:
        type(updates[0]).objects.bulk_update(updates, ["ner_label"])


def extract_persons(
    text: str,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> list[dict]:
    """
    Extract person names from historical newspaper OCR text.

    The model has a 512-token context window. To avoid silently truncating
    long articles, the text is split on blank lines into paragraphs and each
    paragraph is processed independently. Results are deduplicated across
    paragraphs by name.

    The model produces token-level BIO tags; ``aggregation_strategy="simple"``
    merges adjacent tokens into spans automatically.

    Returns a list of dicts (in document order, deduplicated by name) with:
      - ``name``: extracted name string
      - ``score``: mean model confidence across the span tokens (0.0–1.0)

    Only ``PER`` entities at or above ``confidence_threshold`` are returned.
    Names shorter than four characters are dropped as likely OCR noise.
    """
    import re

    if not text or not text.strip():
        return []

    nlp = _get_pipeline()

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    results = []
    seen: set[str] = set()
    for para in paragraphs:
        try:
            entities = nlp(para)
        except Exception as exc:
            logger.error("HF NER inference failed on paragraph: %s", exc)
            continue

        for ent in entities:
            if ent["entity_group"] != "PER":
                continue
            score = float(ent["score"])
            if score < confidence_threshold:
                continue
            name = ent["word"].strip()
            if len(name) < 4 or name in seen:
                continue
            seen.add(name)
            results.append({"name": name, "score": round(score, 4)})

    return results
