"""
Frame-by-frame visualization of the tag_match kernel convolution.

Each frame shows a document page with the current kernel position overlaid and
a side panel summarising the match score and extracted content fields.
Frames are compiled into an MP4 using OpenCV.

Requires: matplotlib, opencv-python (both are project dependencies).
"""

from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.colors as mcolors
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

_SLOT_COLORS = {
    "structural": "#4a9eda",
    "content": "#5cb85c",
    "position": "#aaaaaa",
}

_GHOST_COLORS = {
    "structural": "#e74c3c",  # red
    "content": "#4a9eda",  # blue
    "position": "#888888",
}

_PANEL_BG = "#1e1e2e"
_TEXT_DIM = "#888899"
_TEXT_BRIGHT = "#e0e0f0"


def _score_color(score: float) -> str:
    if score >= 0.75:
        return "#2ecc71"
    elif score >= 0.5:
        return "#f39c12"
    return "#e74c3c"


def render_frame(
    page_img: Image.Image | None,
    page_words: list[dict],
    kernel: list[dict],
    matched_slots: list[dict],
    bbox_left: float,
    bbox_top: float,
    ref_bbox_width: int,
    ref_bbox_height: int,
    score: float,
    frame_size: tuple[int, int] = (1600, 900),
) -> np.ndarray:
    """
    Render one convolution step as an RGB numpy array (H×W×3, uint8).

    page_img: PIL Image of the page at Word coordinate scale, or None to
              fall back to a word-map drawn from page_words.
    """
    fig_w_px, fig_h_px = frame_size
    dpi = 100
    fig = plt.figure(
        figsize=(fig_w_px / dpi, fig_h_px / dpi), dpi=dpi, facecolor=_PANEL_BG
    )

    gs = fig.add_gridspec(
        1,
        2,
        width_ratios=[7, 3],
        wspace=0.02,
        left=0.01,
        right=0.99,
        top=0.99,
        bottom=0.01,
    )
    ax_img = fig.add_subplot(gs[0])
    ax_info = fig.add_subplot(gs[1])

    # ── Left panel: page image + overlay ──────────────────────────────────────

    if page_img is not None:
        img_arr = np.array(page_img.convert("RGB"))
    else:
        img_arr = _word_map(page_words)

    img_h, img_w = img_arr.shape[:2]
    ax_img.imshow(img_arr, origin="upper", aspect="equal", extent=[0, img_w, img_h, 0])

    # Crop x to the word content extent so wide page margins are hidden.
    if page_words:
        _x_min = min(w["left"] for w in page_words)
        _x_max = max(w["left"] + w["width"] for w in page_words)
        _pad = (_x_max - _x_min) * 0.04
        crop_left = max(0, _x_min - _pad)
        crop_right = min(img_w, _x_max + _pad)
    else:
        crop_left, crop_right = 0, img_w

    ax_img.set_xlim(crop_left, crop_right)
    ax_img.set_ylim(img_h, 0)
    ax_img.axis("off")
    ax_img.set_facecolor(_PANEL_BG)

    # Kernel bbox outline
    ax_img.add_patch(
        patches.Rectangle(
            (bbox_left, bbox_top),
            ref_bbox_width,
            ref_bbox_height,
            linewidth=1.5,
            edgecolor="#e67e00",
            facecolor="none",
            linestyle="--",
            alpha=0.85,
            zorder=3,
        )
    )

    # Per-slot overlay
    matched_by_slot = {id(m["slot"]): m for m in matched_slots}
    line_h = ref_bbox_height * 0.07  # estimated single-line height

    for slot in kernel:
        if slot["slot_type"] == "position":
            continue
        ghost_color = _GHOST_COLORS.get(slot["slot_type"], "#888888")
        match_color = _SLOT_COLORS.get(slot["slot_type"], "#888888")
        match = matched_by_slot.get(id(slot))

        # Ghost: expected position for all structural/content slots.
        # Content y-extent is derived from line_rank span × line_h so it isn't
        # inflated by bbox-height variation across training tags.
        if slot["slot_type"] == "content" and "rel_x_min" in slot:
            gx = bbox_left + slot["rel_x_min"] * ref_bbox_width
            gw = (slot["rel_x_max"] - slot["rel_x_min"]) * ref_bbox_width
            n_lines = (
                slot.get("line_rank_max", slot["line_rank"])
                - slot.get("line_rank_min", slot["line_rank"])
                + 1
            )
            gh = max(n_lines * line_h, line_h)
            gy = bbox_top + slot["rel_y"] * ref_bbox_height - gh / 2
        else:
            gx = bbox_left + slot["rel_x"] * ref_bbox_width - ref_bbox_width * 0.04
            gw = ref_bbox_width * 0.08
            gy = bbox_top + slot.get("rel_y", 0) * ref_bbox_height - line_h / 2
            gh = line_h
        rgb = mcolors.to_rgb(ghost_color)
        ax_img.add_patch(
            patches.Rectangle(
                (gx, gy),
                gw,
                gh,
                linewidth=1.5,
                linestyle="--",
                zorder=3,
                edgecolor=(*rgb, 0.70),
                facecolor=(*rgb, 0.08),
            )
        )

        # Solid highlight on top for matched slots.
        if match:
            word_list = match.get("words") or (
                [match["word"]] if "word" in match else []
            )
            for w in word_list:
                ax_img.add_patch(
                    patches.Rectangle(
                        (w["left"], w["top"]),
                        w["width"],
                        w["height"],
                        linewidth=2,
                        edgecolor=match_color,
                        facecolor=match_color,
                        alpha=0.45,
                        zorder=4,
                    )
                )

    # ── Right panel: score + slot list + extracted content ────────────────────

    ax_info.set_facecolor(_PANEL_BG)
    ax_info.axis("off")

    sc = _score_color(score)
    y = 0.96

    ax_info.text(
        0.5,
        y,
        "Score",
        ha="center",
        va="top",
        color=_TEXT_DIM,
        fontsize=9,
        transform=ax_info.transAxes,
    )
    y -= 0.07
    ax_info.text(
        0.5,
        y,
        f"{score:.0%}",
        ha="center",
        va="top",
        color=sc,
        fontsize=32,
        fontweight="bold",
        transform=ax_info.transAxes,
    )
    y -= 0.06

    # Score bar
    bar_h = 0.025
    ax_info.add_patch(
        patches.Rectangle(
            (0.05, y - bar_h / 2),
            0.90,
            bar_h,
            facecolor="#333344",
            transform=ax_info.transAxes,
            zorder=2,
            clip_on=False,
        )
    )
    ax_info.add_patch(
        patches.Rectangle(
            (0.05, y - bar_h / 2),
            0.90 * min(score, 1.0),
            bar_h,
            facecolor=sc,
            transform=ax_info.transAxes,
            zorder=3,
            clip_on=False,
        )
    )
    y -= 0.055

    # ── Extracted content (top of info panel) ────────────────────────────────
    content_hits = [
        m
        for m in matched_slots
        if m["slot"]["slot_type"] == "content" and m["slot"].get("sc_label")
    ]
    ax_info.plot(
        [0.05, 0.95],
        [y, y],
        color="#333355",
        linewidth=0.5,
        transform=ax_info.transAxes,
    )
    y -= 0.04
    ax_info.text(
        0.05,
        y,
        "Extracted",
        va="top",
        color=_TEXT_DIM,
        fontsize=10,
        fontweight="bold",
        transform=ax_info.transAxes,
    )
    y -= 0.055

    if content_hits:
        for m in content_hits:
            if y < 0.30:
                break
            word_list = m.get("words") or ([m["word"]] if "word" in m else [])
            text = " ".join(
                (w.get("corrected_text") or w.get("text") or "") for w in word_list
            ).strip()
            field = m["slot"]["sc_label"]
            ax_info.text(
                0.05,
                y,
                f"{field}:",
                va="top",
                color=_TEXT_DIM,
                fontsize=9,
                transform=ax_info.transAxes,
            )
            y -= 0.05
            if len(text) > 22:
                text = text[:21] + "…"
            ax_info.text(
                0.05,
                y,
                text,
                va="top",
                color=_TEXT_BRIGHT,
                fontsize=11,
                transform=ax_info.transAxes,
            )
            y -= 0.065
    else:
        ax_info.text(
            0.05,
            y,
            "—",
            va="top",
            color=_TEXT_DIM,
            fontsize=10,
            transform=ax_info.transAxes,
        )
        y -= 0.055

    # ── Slot checklist ────────────────────────────────────────────────────────
    ax_info.plot(
        [0.05, 0.95],
        [y, y],
        color="#333355",
        linewidth=0.5,
        transform=ax_info.transAxes,
    )
    y -= 0.04
    ax_info.text(
        0.05,
        y,
        "Slots",
        va="top",
        color=_TEXT_DIM,
        fontsize=8,
        fontweight="bold",
        transform=ax_info.transAxes,
    )
    y -= 0.05

    for slot in kernel:
        if y < 0.04:
            break
        color = _SLOT_COLORS.get(slot["slot_type"], "#888888")
        matched = id(slot) in matched_by_slot
        tick = "✓" if matched else "✗"
        tick_c = "#2ecc71" if matched else "#cc4444"
        label = slot.get("sc_label") or slot.get("text") or slot["slot_type"]
        if len(label) > 17:
            label = label[:16] + "…"
        ax_info.text(
            0.05,
            y,
            tick,
            va="top",
            color=tick_c,
            fontsize=9,
            transform=ax_info.transAxes,
        )
        ax_info.text(
            0.18,
            y,
            label,
            va="top",
            color=color,
            fontsize=8,
            transform=ax_info.transAxes,
        )
        y -= 0.05

    # Render figure → numpy RGB
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    out = Image.open(buf).convert("RGB").resize(frame_size, Image.LANCZOS)
    return np.array(out, dtype=np.uint8)


def _word_map(page_words: list[dict]) -> np.ndarray:
    """Draw Word bboxes on a white canvas when no page image is available."""
    import cv2

    if not page_words:
        return np.full((1000, 800, 3), 245, dtype=np.uint8)
    w = max(wd["left"] + wd["width"] for wd in page_words) + 10
    h = max(wd["top"] + wd["height"] for wd in page_words) + 10
    arr = np.full((h, w, 3), 245, dtype=np.uint8)
    for wd in page_words:
        cv2.rectangle(
            arr,
            (wd["left"], wd["top"]),
            (wd["left"] + wd["width"], wd["top"] + wd["height"]),
            (190, 190, 195),
            1,
        )
    return arr


def frames_to_video(frames: list[np.ndarray], output_path: str, fps: int = 10) -> None:
    """Write a list of RGB numpy arrays to an MP4 file."""
    import cv2

    if not frames:
        return
    h, w = frames[0].shape[:2]
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
    for frame in frames:
        writer.write(frame[:, :, ::-1])  # RGB → BGR
    writer.release()
