// Draws one absolutely-positioned div per OCR word, classed by confidence /
// correction state and toggling the selected modifier from the reducer.

import { useViewerState } from '../state/ViewerContext.jsx';
import { ocrWordClass } from '../state/selectors.js';

export default function OcrOverlay({ scale, hasRepair }) {
  const { words, ocrSelectedIds } = useViewerState();

  return words.map((w) => {
    const baseClass = hasRepair && w.id != null
      ? ocrWordClass(w)
      : 'ocr-word ' + (w.is_ditto ? 'conf-ditto' : w.conf < 60 ? 'conf-low' : w.conf < 80 ? 'conf-mid' : 'conf-high');
    const className = baseClass + (ocrSelectedIds.has(w.id) ? ' selected' : '');
    const title =
      (w.corrected_text ? '✓ ' + w.corrected_text : w.ocr_text) +
      (w.is_ditto ? '' : ' (' + Math.round(w.conf) + '%)');
    return (
      <div
        key={w.id ?? `${w.left}-${w.top}`}
        className={className}
        data-word-id={w.id}
        title={title}
        style={{
          left: Math.round(w.left * scale) + 'px',
          top: Math.round(w.top * scale) + 'px',
          width: Math.round(w.width * scale) + 'px',
          height: Math.round(w.height * scale) + 'px',
        }}
      />
    );
  });
}
