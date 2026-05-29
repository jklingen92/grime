// Floating action bar for NER selections: apply / clear / delete bulk labels.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { nerEntityType } from '../state/selectors.js';

export default function NerSelectionBar({ wrapRef, onApply }) {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const elRef = useRef(null);
  const visible = state.nerSelectedIds.size > 0 && state.tab === 'ner';

  // Default the dropdown to the most-common existing entity type in the selection.
  const dominantType = useMemo(() => {
    const counts = {};
    state.nerSelectedIds.forEach((id) => {
      const t = nerEntityType(state.wordById[id]);
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    let best = '';
    let bestN = 0;
    Object.keys(counts).forEach((k) => {
      if (counts[k] > bestN) {
        best = k;
        bestN = counts[k];
      }
    });
    return best;
  }, [state.nerSelectedIds, state.wordById]);

  const [type, setType] = useState(dominantType);
  // Keep the dropdown synced when the selection changes.
  useEffect(() => {
    setType(dominantType);
  }, [dominantType]);

  const labelText = useMemo(() => {
    const ids = Array.from(state.nerSelectedIds);
    const words = ids.map((id) => state.wordById[id]).filter(Boolean);
    words.sort((a, b) => {
      if (a.line_num !== b.line_num) return (a.line_num || 0) - (b.line_num || 0);
      return (a.word_num || 0) - (b.word_num || 0);
    });
    let text = words.map((w) => w.corrected_text || w.ocr_text).join(' ');
    if (text.length > 40) text = text.substring(0, 37) + '…';
    return '“' + text + '”';
  }, [state.nerSelectedIds, state.wordById]);

  useLayoutEffect(() => {
    if (visible && elRef.current && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      elRef.current.style.left = rect.right - 8 + 'px';
      elRef.current.style.top = rect.top + 8 + 'px';
    }
  }, [visible, labelText, wrapRef]);

  return (
    <div id="ner-select-bar" ref={elRef} style={{ display: visible ? 'flex' : 'none' }}>
      <label id="ner-select-label">{labelText}</label>
      <select
        id="ner-select-type"
        className="form-select form-select-sm"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <option value="">— label —</option>
        <option value="PER">Person</option>
        <option value="LOC">Location</option>
        <option value="ORG">Organization</option>
      </select>
      <button
        id="ner-select-apply"
        className="btn btn-sm btn-primary"
        onClick={() => onApply(type)}
      >
        <i className="fa-solid fa-check me-1" />
        Apply
      </button>
      <button
        id="ner-select-delete"
        className="btn btn-sm btn-outline-danger"
        onClick={() => onApply('NONE')}
      >
        <i className="fa-solid fa-trash me-1" />
        Delete
      </button>
      <button
        id="ner-select-cancel"
        className="btn btn-sm btn-outline-secondary"
        onClick={() => dispatch({ type: 'NER_SELECT_CLEAR' })}
      >
        <i className="fa-solid fa-xmark me-1" />
        Cancel
      </button>
    </div>
  );
}
