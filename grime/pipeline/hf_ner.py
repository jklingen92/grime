# Backwards-compatibility shim — all logic now lives in pipeline.ner.
from grime.pipeline.ner import (  # noqa: F401
    DEFAULT_CONFIDENCE_THRESHOLD,
    extract_entities,
    extract_persons,
    label_ocr_words,
    reload_pipeline,
)
