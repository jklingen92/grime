// Renders one overlay box per NER entity per line (grouped) plus an
// individual box for each unlabeled word. Matches viewer-ner.js:252 render().

import { useMemo } from 'react';
import { useViewerState } from '../state/ViewerContext.jsx';
import { buildEntities, highlightWordIdSet } from '../state/selectors.js';

export default function NerOverlay({ scale }) {
  const { words, wordById, nerSelectedIds, nerHighlightKey } = useViewerState();

  const entities = useMemo(() => buildEntities(words), [words]);
  const highlightIds = useMemo(
    () => highlightWordIdSet(words, nerHighlightKey),
    [words, nerHighlightKey],
  );

  const boxes = [];
  const renderedIds = new Set();

  entities.forEach((entity, entityIdx) => {
    const byLine = {};
    entity.wordIds.forEach((id) => {
      const w = wordById[id];
      if (!w) return;
      const ln = w.line_num != null ? w.line_num : 0;
      if (!byLine[ln]) byLine[ln] = [];
      byLine[ln].push(w);
    });
    Object.keys(byLine).forEach((ln) => {
      const lineWords = byLine[ln];
      const lineIds = lineWords.map((w) => w.id);
      lineIds.forEach((id) => renderedIds.add(id));
      const left = Math.min(...lineWords.map((w) => w.left));
      const top = Math.min(...lineWords.map((w) => w.top));
      const right = Math.max(...lineWords.map((w) => w.left + w.width));
      const bottom = Math.max(...lineWords.map((w) => w.top + w.height));
      const isSel = lineIds.some((id) => nerSelectedIds.has(id));
      const isHigh = lineIds.some((id) => highlightIds.has(id));
      let className = 'dp-ner-overlay ner-' + entity.type;
      if (isSel) className += ' selected';
      if (isHigh) className += ' entity-highlight';
      const title =
        entity.type +
        ': ' +
        lineWords.map((w) => w.corrected_text || w.ocr_text).join(' ');
      boxes.push(
        <div
          key={`e-${entityIdx}-${ln}`}
          className={className}
          data-word-ids={lineIds.join(',')}
          title={title}
          style={{
            left: Math.round(left * scale) + 'px',
            top: Math.round(top * scale) + 'px',
            width: Math.round((right - left) * scale) + 'px',
            height: Math.round((bottom - top) * scale) + 'px',
          }}
        />,
      );
    });
  });

  words.forEach((w) => {
    if (renderedIds.has(w.id)) return;
    let className = 'dp-ner-overlay ner-NONE';
    if (nerSelectedIds.has(w.id)) className += ' selected';
    if (highlightIds.has(w.id)) className += ' entity-highlight';
    boxes.push(
      <div
        key={`u-${w.id}`}
        className={className}
        data-word-ids={String(w.id)}
        title={w.corrected_text || w.ocr_text}
        style={{
          left: Math.round(w.left * scale) + 'px',
          top: Math.round(w.top * scale) + 'px',
          width: Math.round(w.width * scale) + 'px',
          height: Math.round(w.height * scale) + 'px',
        }}
      />,
    );
  });

  return boxes;
}
