// OCR text panel: search box + line-by-line word spans synced to selection.

import { useMemo, useRef } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { buildLineMap } from '../state/selectors.js';

export default function OcrPanel() {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();

  const containerRef = useRef(null);
  const suppressClickRef = useRef(false);

  const lines = useMemo(() => buildLineMap(state.words), [state.words]);

  const query = (state.textSearchQuery || '').toLowerCase();
  const matchIds = useMemo(() => {
    if (!query) return new Set();
    const out = new Set();
    state.words.forEach((w) => {
      const t = (w.corrected_text || w.ocr_text || '').toLowerCase();
      if (t.indexOf(query) >= 0 && w.id != null) out.add(w.id);
    });
    return out;
  }, [query, state.words]);

  function handleQueryChange(q) {
    dispatch({ type: 'OCR_SET_SEARCH', query: q });
    if (q) {
      const ids = [];
      state.words.forEach((w) => {
        const t = (w.corrected_text || w.ocr_text || '').toLowerCase();
        if (t.indexOf(q.toLowerCase()) >= 0 && w.id != null) ids.push(w.id);
      });
      dispatch({ type: 'OCR_SELECT_REPLACE', ids });
    } else {
      dispatch({ type: 'OCR_SELECT_CLEAR' });
    }
  }

  function onWordClick(e, wid) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (e.shiftKey) {
      dispatch({ type: 'OCR_SELECT_TOGGLE', id: wid });
    } else {
      dispatch({ type: 'OCR_SELECT_REPLACE', ids: [wid] });
    }
  }

  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const hitIds = [];
    if (!containerRef.current) return;
    containerRef.current.querySelectorAll('.dp-text-word').forEach((span) => {
      const spanRange = document.createRange();
      spanRange.selectNode(span);
      if (
        range.compareBoundaryPoints(Range.END_TO_START, spanRange) <= 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, spanRange) >= 0
      ) {
        const id = parseInt(span.dataset.wordId, 10);
        if (!Number.isNaN(id)) hitIds.push(id);
      }
    });
    if (!hitIds.length) return;
    dispatch({ type: 'OCR_SELECT_REPLACE', ids: hitIds });
    sel.removeAllRanges();
    suppressClickRef.current = true;
  }

  return (
    <div id="dp-text-panel" className="visible">
      <h3>OCR Text</h3>
      <div id="dp-ocr-instructions">
        {config.hasRepair && (
          <>
            <span>Click a word to edit.</span>
            <span>Drag to select · ↑↓ to reorder.</span>
            <span>Select 2+ to merge or join lines.</span>
          </>
        )}
        <div id="dp-ocr-conf-legend">
          <span className="dp-ocr-legend-title">Confidence</span>
          <span>
            <span className="dp-conf-swatch conf-low" />
            Low (&lt;60)
          </span>
          <span>
            <span className="dp-conf-swatch conf-mid" />
            Mid (60–80)
          </span>
          <span>
            <span className="dp-conf-swatch conf-high" />
            High (&gt;80)
          </span>
          {config.hasRepair && (
            <span>
              <span className="dp-conf-swatch conf-corrected" />
              Corrected
            </span>
          )}
        </div>
      </div>
      <div id="dp-text-search-row">
        <input
          id="dp-text-search"
          type="search"
          className="form-control form-control-sm"
          placeholder="Search text…"
          autoComplete="off"
          value={state.textSearchQuery}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleQueryChange('');
          }}
        />
        {state.textSearchQuery && (
          <button
            id="dp-text-search-clear"
            type="button"
            className="btn btn-sm btn-outline-secondary"
            title="Clear search"
            onClick={() => handleQueryChange('')}
          >
            <i className="fa-solid fa-xmark" />
          </button>
        )}
        <span id="dp-text-search-count">
          {query
            ? matchIds.size
              ? matchIds.size + ' match' + (matchIds.size === 1 ? '' : 'es')
              : 'no matches'
            : ''}
        </span>
      </div>
      <div id="dp-corrected-text" ref={containerRef} onMouseUp={onMouseUp}>
        {lines.map((line) => {
          const renderedWords = line.words.filter((w) =>
            (w.corrected_text || w.ocr_text || '').trim(),
          );
          if (!renderedWords.length) return null;
          return (
            <div key={line.l} className="dp-text-line">
              {renderedWords.map((w) => {
                const display = w.corrected_text || w.ocr_text;
                let cls = 'dp-text-word';
                if (state.ocrSelectedIds.has(w.id)) cls += ' selected';
                if (matchIds.has(w.id)) cls += ' search-match';
                return (
                  <span
                    key={w.id}
                    className={cls}
                    data-word-id={w.id}
                    onClick={(e) => onWordClick(e, w.id)}
                  >
                    {display}{' '}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
