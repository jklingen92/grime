"""
Semantic kernel matching for tagged document regions.

Given a set of Tag examples with the same label, builds a consensus "kernel"
from their Word subcomponents and slides it across candidate pages to find
similar regions.

Each kernel slot is typed as structural (text must match), content (entity type
must match), or position-only (proximity alone). Structural slots are determined
by text consensus across examples; content slots use the ner_label on Words to
require matching entity types. Multi-word entities are concatenated in reading
order to produce inferred subcomponent field values.

Usage::

    from grime.pipeline.tag_match import build_kernel, search_page
    from grime.models import Word, Tag

    tags = list(Tag.objects.filter(label="member entry"))
    kernel = build_kernel(tags)
    page_words = list(Word.objects.filter(page=page).values(
        "id","left","top","width","height","text","corrected_text",
        "ner_label","corrected_ner_label","line_num","word_num",
    ))
    matches = search_page(kernel, page_words)
"""

from __future__ import annotations

import statistics
from typing import Any

# ---------------------------------------------------------------------------
# Inline Levenshtein — no extra dependency
# ---------------------------------------------------------------------------


def _levenshtein(a: str, b: str) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(
                min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (0 if ca == cb else 1))
            )
        prev = curr
    return prev[-1]


def _text_similar(a: str, b: str) -> bool:
    """Return True if a and b are similar enough to count as a text match."""
    a = "".join(c for c in a.lower() if c.isalpha())
    b = "".join(c for c in b.lower() if c.isalpha())
    if not a or not b:
        return False
    if len(a) <= 3 or len(b) <= 3:
        return a == b
    dist = _levenshtein(a, b)
    return dist / max(len(a), len(b)) <= 0.3


# ---------------------------------------------------------------------------
# Kernel construction
# ---------------------------------------------------------------------------


def _word_canonical(word_dict: dict) -> str:
    ct = word_dict.get("corrected_text")
    return (ct if ct is not None else word_dict.get("text", "")) or ""


def _assign_line_ranks(words: list[dict]) -> list[list[dict]]:
    """
    Group words by OCR line key, sort groups by median cy, merge groups
    that are within ~60% of a line height vertically (handles two-column
    layout where left/right columns have slightly different y due to page
    curve), then assign each word a '_line_rank' and '_line_rel_x'.

    Returns the sorted list of merged line groups.
    """
    line_groups: dict[int, list] = {}
    for w in words:
        line_groups.setdefault(w.get("line_num") or 0, []).append(w)

    sorted_groups = sorted(
        line_groups.values(),
        key=lambda g: statistics.median(w["top"] + w["height"] / 2 for w in g),
    )

    # Merge threshold: fraction of the median word height below which two
    # consecutive OCR lines are considered the same visual row.
    all_heights = [w["height"] for w in words if w.get("height", 0) > 0]
    line_h = statistics.median(all_heights) if all_heights else 20
    merge_threshold = line_h * 0.6

    merged: list[list[dict]] = []
    for group in sorted_groups:
        group_mid = statistics.median(w["top"] + w["height"] / 2 for w in group)
        if merged:
            prev_mid = statistics.median(w["top"] + w["height"] / 2 for w in merged[-1])
            if group_mid - prev_mid <= merge_threshold:
                merged[-1].extend(group)
                continue
        merged.append(list(group))

    lines_by_rank = []
    for rank, line_words in enumerate(merged):
        cxs = [w["left"] + w["width"] / 2 for w in line_words]
        lmin, lmax = min(cxs), max(cxs)
        lspan = lmax - lmin
        for word, cx in zip(line_words, cxs):
            word["_line_rank"] = rank
            word["_line_rel_x"] = (cx - lmin) / lspan if lspan > 0 else 0.5
        lines_by_rank.append(line_words)

    return lines_by_rank


def _process_tag_words(
    tag,
    words: list[dict],
    sc_labels: dict[int, str],
) -> tuple[list[dict], list[dict], list[dict], list[float]]:
    """
    Convert a single tag's line-ranked Words into per-tag slot lists.

    ``words`` must already have ``_line_rank`` and ``_line_rel_x`` set by
    ``_assign_line_ranks``.  ``sc_labels`` maps Word pk → user-assigned label.

    Returns ``(content_slots, pos_slots, struct_slots)`` where:

    * content_slots — one slot per horizontal proximity group per (sc_label, line_rank)
    * pos_slots     — one slot per line rank (Track A: positional scaffold); includes ``words``
    * struct_slots  — one slot per (norm_text, line_rank) (Track B: key text)
    """

    def _norm(t: str) -> str:
        return "".join(c for c in t.lower() if c.isalpha())

    px_heights = [w["height"] for w in words if w.get("height", 0) > 0]
    median_h_px = statistics.median(px_heights) if px_heights else 20

    entries = []
    for w in words:
        rx0 = (w["left"] - tag.bbox_left) / median_h_px
        rx1 = (w["left"] + w["width"] - tag.bbox_left) / median_h_px
        lr = w["_line_rank"]
        # y-axis in line_rank units: each discrete text line occupies 1 unit,
        # ignoring pixel whitespace between lines.
        ry0 = float(lr)
        ry1 = float(lr + 1)
        sc_lbl = sc_labels.get(w["id"], "")
        canon = _word_canonical(w)
        norm_t = _norm(canon)
        if not sc_lbl and not norm_t:
            continue
        entries.append(
            {
                "rel_x_min": rx0,
                "rel_y_min": ry0,
                "rel_x_max": rx1,
                "rel_y_max": ry1,
                "rel_x": (rx0 + rx1) / 2,
                "rel_y": lr + 0.5,
                "line_rank": lr,
                "line_rel_x": w["_line_rel_x"],
                "sc_label": sc_lbl,
                "norm_text": norm_t,
                "text": canon,
            }
        )

    content_entries = [e for e in entries if e["sc_label"]]
    noncontent_entries = [e for e in entries if not e["sc_label"]]

    # Trim non-content lines outside the content range and renumber from 0.
    # Whitespace bands above the first content label or below the last are noise.
    if content_entries:
        min_cr = min(e["line_rank"] for e in content_entries)
        max_cr = max(e["line_rank"] for e in content_entries)

        def _trim_renumber(es: list[dict]) -> list[dict]:
            out = []
            for e in es:
                if e["line_rank"] < min_cr or e["line_rank"] > max_cr:
                    continue
                e = dict(e)
                new_lr = e["line_rank"] - min_cr
                e["line_rank"] = new_lr
                e["rel_y_min"] = float(new_lr)
                e["rel_y_max"] = float(new_lr + 1)
                e["rel_y"] = new_lr + 0.5
                out.append(e)
            return out

        content_entries = _trim_renumber(content_entries)
        noncontent_entries = _trim_renumber(noncontent_entries)

    # ── Content: group by (sc_label, line_rank), merge horizontally by proximity ──
    # Each row stays its own slot; no vertical merging across line ranks.
    content_by_sc_lr: dict[tuple, list[dict]] = {}
    for e in content_entries:
        content_by_sc_lr.setdefault((e["sc_label"], e["line_rank"]), []).append(e)

    content_slots: list[dict] = []
    for (sc_lbl, lr), lr_entries in content_by_sc_lr.items():
        lr_sorted = sorted(lr_entries, key=lambda e: e["rel_x_min"])
        groups: list[list[dict]] = [[lr_sorted[0]]]
        for e in lr_sorted[1:]:
            if e["rel_x_min"] - groups[-1][-1]["rel_x_max"] <= 1.0:
                groups[-1].append(e)
            else:
                groups.append([e])
        for group in groups:
            ms: dict = {
                "line_rank": lr,
                "line_rank_max": lr,
                "rel_x_min": min(e["rel_x_min"] for e in group),
                "rel_y_min": min(e["rel_y_min"] for e in group),
                "rel_x_max": max(e["rel_x_max"] for e in group),
                "rel_y_max": max(e["rel_y_max"] for e in group),
                "sc_label": sc_lbl,
                "text": group[0]["text"],
                "words": group,
            }
            ms["rel_x"] = (ms["rel_x_min"] + ms["rel_x_max"]) / 2
            ms["rel_y"] = (ms["rel_y_min"] + ms["rel_y_max"]) / 2
            lrxs = [e["line_rel_x"] for e in group]
            ms["line_rel_x"] = statistics.median(lrxs)
            ms["line_rel_x_min"] = min(lrxs)
            ms["line_rel_x_max"] = max(lrxs)
            content_slots.append(ms)

    # ── Track A (positional): proximity groups per line_rank (same rule as content) ──
    by_line_rank: dict[int, list[dict]] = {}
    for e in noncontent_entries:
        by_line_rank.setdefault(e["line_rank"], []).append(e)

    pos_slots: list[dict] = []
    for lr, lr_entries in by_line_rank.items():
        lr_sorted = sorted(lr_entries, key=lambda e: e["rel_x_min"])
        groups: list[list[dict]] = [[lr_sorted[0]]]
        for e in lr_sorted[1:]:
            if e["rel_x_min"] - groups[-1][-1]["rel_x_max"] <= 1.0:
                groups[-1].append(e)
            else:
                groups.append([e])
        for group in groups:
            lrxs = [e["line_rel_x"] for e in group]
            rx_min = min(e["rel_x_min"] for e in group)
            ry_min = min(e["rel_y_min"] for e in group)
            rx_max = max(e["rel_x_max"] for e in group)
            ry_max = max(e["rel_y_max"] for e in group)
            pos_slots.append(
                {
                    "rel_x_min": rx_min,
                    "rel_y_min": ry_min,
                    "rel_x_max": rx_max,
                    "rel_y_max": ry_max,
                    "rel_x": (rx_min + rx_max) / 2,
                    "rel_y": statistics.median(e["rel_y"] for e in group),
                    "line_rel_x": statistics.median(lrxs),
                    "line_rel_x_min": min(lrxs),
                    "line_rel_x_max": max(lrxs),
                    "line_rank": lr,
                    "line_rank_max": lr,
                    "words": group,
                }
            )

    # ── Track B (structural): group by (norm_text, line_rank), merge horizontally by proximity ──
    by_norm_lr: dict[tuple, list[dict]] = {}
    for e in noncontent_entries:
        by_norm_lr.setdefault((e["norm_text"], e["line_rank"]), []).append(e)

    struct_slots: list[dict] = []
    for (norm_t, lr), lr_entries in by_norm_lr.items():
        lr_sorted = sorted(lr_entries, key=lambda e: e["rel_x_min"])
        groups: list[list[dict]] = [[lr_sorted[0]]]
        for e in lr_sorted[1:]:
            if e["rel_x_min"] - groups[-1][-1]["rel_x_max"] <= 1.0:
                groups[-1].append(e)
            else:
                groups.append([e])
        for group in groups:
            lrxs = [e["line_rel_x"] for e in group]
            rx_min = min(e["rel_x_min"] for e in group)
            ry_min = min(e["rel_y_min"] for e in group)
            rx_max = max(e["rel_x_max"] for e in group)
            ry_max = max(e["rel_y_max"] for e in group)
            struct_slots.append(
                {
                    "rel_x_min": rx_min,
                    "rel_y_min": ry_min,
                    "rel_x_max": rx_max,
                    "rel_y_max": ry_max,
                    "rel_x": (rx_min + rx_max) / 2,
                    "rel_y": statistics.median(e["rel_y"] for e in group),
                    "line_rel_x": statistics.median(lrxs),
                    "line_rel_x_min": min(lrxs),
                    "line_rel_x_max": max(lrxs),
                    "line_rank": lr,
                    "line_rank_max": lr,
                    "text": group[0]["text"],
                    "norm_text": norm_t,
                }
            )

    return content_slots, pos_slots, struct_slots


def _build_kernel(
    tags: list, threshold_frac: float = 0.5, padding: float = 0.05
) -> list[dict]:
    """
    Bbox-based kernel builder.

    Uses full word bounding boxes instead of word centers. Per tag, words sharing
    the same sc_label or normalized text on adjacent lines are merged into a single
    bbox. These per-tag merged bboxes are aggregated across tags with percentile
    statistics.

    Differences from v1:
      - Full word bboxes: slot extents reflect actual word area, not just centers.
      - Same-label adjacent-line merging: multi-line content fields become one slot.
      - No position slots; only structural (text consensus) and content (sc_label).
      - line_rank is assigned post-aggregation by sorting all slots by rel_y.
    """
    if not tags:
        return []

    from django.db.models import ExpressionWrapper, F, FloatField

    from grime.models import Word

    sc_labels: dict[int, str] = {}
    for tag in tags:
        for sc in tag.subcomponents or []:
            wid = sc.get("word_id") or sc.get("ocr_word_id")
            if wid is not None:
                sc_labels[wid] = sc.get("label", "")

    content_by_label: dict[str, list[dict]] = {}
    all_struct_slots: list[dict] = (
        []
    )  # Track B: all structural slots, clustered by position
    position_slots_all: list[dict] = (
        []
    )  # Track A: per-tag positional groups, clustered later
    n_tags = len(tags)

    for tag in tags:
        if not tag.bbox_width or not tag.bbox_height:
            continue

        words = list(
            Word.objects.filter(page_id=tag.source_id)
            .annotate(
                cx=ExpressionWrapper(
                    F("left") + F("width") / 2.0, output_field=FloatField()
                ),
                cy=ExpressionWrapper(
                    F("top") + F("height") / 2.0, output_field=FloatField()
                ),
            )
            .filter(
                cx__gte=tag.bbox_left - tag.bbox_width * padding,
                cx__lte=tag.bbox_left + tag.bbox_width * (1 + padding),
                cy__gte=tag.bbox_top - tag.bbox_height * padding,
                cy__lte=tag.bbox_top + tag.bbox_height * (1 + padding),
            )
            .values(
                "id",
                "left",
                "top",
                "width",
                "height",
                "text",
                "corrected_text",
                "line_num",
            )
        )
        if not words:
            continue

        words_copy = [dict(w) for w in words]
        _assign_line_ranks(words_copy)

        content_slots, pos_slots, struct_slots = _process_tag_words(
            tag, words_copy, sc_labels
        )
        for ms in content_slots:
            content_by_label.setdefault(ms["sc_label"], []).append(ms)
        position_slots_all.extend(pos_slots)
        all_struct_slots.extend(struct_slots)

    def _pct(vals: list[float], p: float) -> float:
        sv = sorted(vals)
        n = len(sv)
        if n == 1:
            return sv[0]
        idx = (n - 1) * p / 100.0
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        return sv[lo] + (sv[hi] - sv[lo]) * (idx - lo)

    def _pos_split(slots: list[dict]) -> list[list[dict]]:
        """Split per-tag slots into positionally distinct groups (> 2× word height apart)."""
        if not slots:
            return []
        by_y = sorted(slots, key=lambda s: s["rel_y"])
        groups: list[list[dict]] = [[by_y[0]]]
        gap = 2.0
        for s in by_y[1:]:
            if s["rel_y"] - groups[-1][-1]["rel_y"] > gap:
                groups.append([])
            groups[-1].append(s)
        return groups

    def _x_split(slots: list[dict]) -> list[list[dict]]:
        """Split slots into horizontally distinct groups (> 2× word height apart in x)."""
        if not slots:
            return []
        by_x = sorted(slots, key=lambda s: s["rel_x"])
        groups: list[list[dict]] = [[by_x[0]]]
        for s in by_x[1:]:
            if s["rel_x"] - groups[-1][-1]["rel_x"] > 2.0:
                groups.append([s])
            else:
                groups[-1].append(s)
        return groups

    def _pos_cluster(slots: list[dict]) -> list[list[dict]]:
        """Cluster structural-line slots by rel_y proximity (within 0.8 × word height)."""
        if not slots:
            return []
        by_y = sorted(slots, key=lambda s: s["rel_y"])
        groups: list[list[dict]] = [[by_y[0]]]
        threshold = 0.8
        for s in by_y[1:]:
            if s["rel_y"] - groups[-1][-1]["rel_y"] <= threshold:
                groups[-1].append(s)
            else:
                groups.append([s])
        return groups

    proto_slots: list[dict] = []

    # Aggregate position slots (Track A): cluster by y then x proximity, no merging across gaps
    for y_cluster in _pos_cluster(position_slots_all):
        for grp in _x_split(y_cluster):
            if n_tags > 1 and len(grp) / n_tags <= threshold_frac:
                continue
            lo, hi = (10, 90) if len(grp) >= 8 else (0, 100)
            proto_slots.append(
                {
                    "slot_type": "position",
                    "sc_label": "",
                    "text": "",
                    "rel_x": statistics.median(s["rel_x"] for s in grp),
                    "rel_y": statistics.median(s["rel_y"] for s in grp),
                    "rel_x_min": _pct([s["rel_x_min"] for s in grp], lo),
                    "rel_x_max": _pct([s["rel_x_max"] for s in grp], hi),
                    "rel_y_min": _pct([s["rel_y_min"] for s in grp], lo),
                    "rel_y_max": _pct([s["rel_y_max"] for s in grp], hi),
                    "line_rel_x": statistics.median(s["line_rel_x"] for s in grp),
                    "line_rel_x_min": _pct([s["line_rel_x_min"] for s in grp], lo),
                    "line_rel_x_max": _pct([s["line_rel_x_max"] for s in grp], hi),
                    "_span": 0,
                }
            )

    # Aggregate content slots by sc_label
    for sc_label, tag_slots in content_by_label.items():
        if n_tags > 1 and len(tag_slots) / n_tags <= threshold_frac:
            continue
        lo, hi = (10, 90) if len(tag_slots) >= 8 else (0, 100)
        spans = [s["line_rank_max"] - s["line_rank"] for s in tag_slots]
        proto_slots.append(
            {
                "slot_type": "content",
                "sc_label": sc_label,
                "text": "",
                "rel_x": statistics.median(s["rel_x"] for s in tag_slots),
                "rel_y": statistics.median(s["rel_y"] for s in tag_slots),
                "rel_x_min": _pct([s["rel_x_min"] for s in tag_slots], lo),
                "rel_x_max": _pct([s["rel_x_max"] for s in tag_slots], hi),
                "rel_y_min": _pct([s["rel_y_min"] for s in tag_slots], lo),
                "rel_y_max": _pct([s["rel_y_max"] for s in tag_slots], hi),
                "line_rel_x": statistics.median(s["line_rel_x"] for s in tag_slots),
                "line_rel_x_min": _pct([s["line_rel_x_min"] for s in tag_slots], lo),
                "line_rel_x_max": _pct([s["line_rel_x_max"] for s in tag_slots], hi),
                "_span": round(statistics.median(spans)),
            }
        )

    # Aggregate structural slots by position only (no text-based pooling):
    # cluster by y proximity then x proximity; text is whatever the majority shows.
    for y_cluster in _pos_cluster(all_struct_slots):
        for grp in _x_split(y_cluster):
            if n_tags > 1 and len(grp) / n_tags <= threshold_frac:
                continue
            lo, hi = (10, 90) if len(grp) >= 8 else (0, 100)
            texts = [s["text"] for s in grp if s.get("text")]
            rep_text = max(set(texts), key=texts.count) if texts else ""
            proto_slots.append(
                {
                    "slot_type": "structural",
                    "sc_label": "",
                    "text": rep_text,
                    "rel_x": statistics.median(s["rel_x"] for s in grp),
                    "rel_y": statistics.median(s["rel_y"] for s in grp),
                    "rel_x_min": _pct([s["rel_x_min"] for s in grp], lo),
                    "rel_x_max": _pct([s["rel_x_max"] for s in grp], hi),
                    "rel_y_min": _pct([s["rel_y_min"] for s in grp], lo),
                    "rel_y_max": _pct([s["rel_y_max"] for s in grp], hi),
                    "line_rel_x": statistics.median(s["line_rel_x"] for s in grp),
                    "line_rel_x_min": _pct([s["line_rel_x_min"] for s in grp], lo),
                    "line_rel_x_max": _pct([s["line_rel_x_max"] for s in grp], hi),
                    "_span": 0,
                }
            )

    # Assign line_rank post-aggregation: sort by rel_y, group within 0.6 × line height
    proto_slots.sort(key=lambda s: s["rel_y"])
    rank = 0
    for i, slot in enumerate(proto_slots):
        if i > 0 and slot["rel_y"] - proto_slots[i - 1]["rel_y"] > 0.6:
            rank += 1
        slot["line_rank"] = rank
        span = slot.pop("_span")
        slot["line_rank_min"] = rank
        slot["line_rank_max"] = rank + span

    return proto_slots


def build_kernel(
    tags: list,
    threshold_frac: float = 0.5,
    padding: float = 0.05,
) -> list[dict]:
    """
    Build a consensus kernel from one or more Tag instances sharing the same label.
    """
    return _build_kernel(tags, threshold_frac=threshold_frac, padding=padding)


# ---------------------------------------------------------------------------
# Page search
# ---------------------------------------------------------------------------


def _filter_by_line_rel_x(
    words: list[dict], slot: dict, tolerance: float
) -> list[dict]:
    """Return words whose relative x position falls within the slot's line_rel_x range."""
    if not words or "line_rel_x_min" not in slot:
        return words
    cxs = [w["left"] + w["width"] / 2 for w in words]
    lmin, lmax = min(cxs), max(cxs)
    lspan = lmax - lmin
    if lspan <= 0:
        return words
    return [
        w
        for w, cx in zip(words, cxs)
        if slot["line_rel_x_min"] - tolerance
        <= (cx - lmin) / lspan
        <= slot["line_rel_x_max"] + tolerance
    ]


def _match_bbox(
    matched_slots: list[dict], page_lines: list[list[dict]], start_idx: int
) -> tuple[int, int]:
    """Derive bbox top-left from matched words, falling back to the start line."""
    all_words: list[dict] = []
    for m in matched_slots:
        if "words" in m:
            all_words.extend(m["words"])
        elif "word" in m:
            all_words.append(m["word"])
    if all_words:
        return min(w["left"] for w in all_words), min(w["top"] for w in all_words)
    if start_idx < len(page_lines) and page_lines[start_idx]:
        line = page_lines[start_idx]
        return min(w["left"] for w in line), min(w["top"] for w in line)
    return 0, 0


def search_page(
    kernel: list[dict],
    page_words: list[dict],
    tolerance: float = 0.5,
    min_score: float = 0.5,
    step_callback=None,
) -> list[dict]:
    """
    Scan the kernel across page lines and return matches above min_score.

    Treats the page as a sequence of text lines.  For each candidate start line,
    kernel line 0 is matched against that page line, kernel line 1 against the
    next, and so on.  No anchor word is designated; confidence emerges from how
    well each page window satisfies the kernel slots.

    ``tolerance`` is used as a fraction of line width when filtering by
    line_rel_x (content and position slots).

    page_words: list of Word dicts with at minimum:
      id, left, top, width, height, text, corrected_text, ner_label, corrected_ner_label

    Returns list of:
      {
        left: int, top: int,
        score: float,
        inferred_subcomponents: [{label, text, word_ids, words}, ...]
      }
    sorted by score descending.
    """
    if not kernel or not page_words:
        return []

    page_lines = _assign_line_ranks(list(page_words))
    n_page_lines = len(page_lines)
    total_slots = len(kernel)

    results: list[dict] = []

    for start_idx in range(n_page_lines):
        matched_slots: list[dict] = []

        for slot in kernel:
            slot_type = slot["slot_type"]

            if slot_type == "content":
                lr_min = slot.get("line_rank_min", slot["line_rank"])
                lr_max = slot.get("line_rank_max", slot["line_rank"])
                row_words: list[dict] = []
                for lr_off in range(lr_min, lr_max + 1):
                    page_lr = start_idx + lr_off
                    if 0 <= page_lr < n_page_lines:
                        row_words.extend(page_lines[page_lr])
                if not row_words:
                    continue
                words_in_box = _filter_by_line_rel_x(row_words, slot, tolerance)
                if words_in_box:
                    matched_slots.append({"slot": slot, "words": words_in_box})

            elif slot_type == "structural":
                page_lr = start_idx + slot["line_rank"]
                if 0 <= page_lr < n_page_lines:
                    for w in page_lines[page_lr]:
                        if _text_similar(slot["text"], _word_canonical(w)):
                            matched_slots.append({"slot": slot, "word": w})
                            break

            else:  # position
                page_lr = start_idx + slot["line_rank"]
                if 0 <= page_lr < n_page_lines:
                    words_in_range = _filter_by_line_rel_x(
                        page_lines[page_lr], slot, tolerance
                    )
                    if words_in_range:
                        matched_slots.append({"slot": slot, "word": words_in_range[0]})

        score = len(matched_slots) / total_slots

        if step_callback is not None:
            bl, bt = _match_bbox(matched_slots, page_lines, start_idx)
            step_callback(bl, bt, score, matched_slots)

        if score < min_score:
            continue

        bbox_left, bbox_top = _match_bbox(matched_slots, page_lines, start_idx)
        inferred = _collect_subcomponents(matched_slots)
        results.append(
            {
                "left": int(bbox_left),
                "top": int(bbox_top),
                "score": round(score, 3),
                "inferred_subcomponents": inferred,
            }
        )

    results.sort(key=lambda r: r["score"], reverse=True)
    return results


def _collect_subcomponents(matched_slots: list[dict]) -> list[dict]:
    """
    Group matched words by sc_label (for content slots); structural slots are skipped.
    """
    groups: dict[str, list[dict]] = {}
    for m in matched_slots:
        slot = m["slot"]
        if slot["slot_type"] == "content" and slot.get("sc_label"):
            key = slot["sc_label"]
            words = m.get("words") or ([m["word"]] if "word" in m else [])
        elif slot["slot_type"] == "structural":
            key = "__structural__"
            words = [m["word"]]
        else:
            continue
        groups.setdefault(key, []).extend(words)

    result = []
    for key, words in groups.items():
        if key == "__structural__":
            continue
        words.sort(
            key=lambda w: (
                w.get("line_num", 0),
                w.get("word_num", 0),
                w["top"],
                w["left"],
            )
        )
        text_parts = [_word_canonical(w) for w in words if _word_canonical(w)]
        result.append(
            {
                "label": key,
                "text": " ".join(text_parts),
                "word_ids": [w["id"] for w in words],
                "words": words,
            }
        )

    return result
