// Helpers for canvas drag gestures shared by OCR, NER, and Annotation.

export function viewerOffsetFor(viewerEl, e) {
  const r = viewerEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function updateRubberBandRect(rectEl, x0, y0, x1, y1, viewerRect) {
  if (!rectEl) return;
  rectEl.style.left = Math.min(x0, x1) - viewerRect.left + 'px';
  rectEl.style.top = Math.min(y0, y1) - viewerRect.top + 'px';
  rectEl.style.width = Math.abs(x1 - x0) + 'px';
  rectEl.style.height = Math.abs(y1 - y0) + 'px';
  rectEl.style.display = 'block';
}

export function dist(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

export function wordsInRect(words, scale, x1, y1, x2, y2) {
  const px1 = x1 / scale;
  const py1 = y1 / scale;
  const px2 = x2 / scale;
  const py2 = y2 / scale;
  return words.filter(
    (w) =>
      w.left + w.width > px1 &&
      w.left < px2 &&
      w.top + w.height > py1 &&
      w.top < py2,
  );
}
