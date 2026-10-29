// Floating action bar for NER selections: apply entity label / delete / cancel.
// The apply button is a Bootstrap split button whose dropdown picks the type.

import { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { nerEntityType } from '../state/selectors.js';

const ENTITY_TYPES = [
  { value: 'PER', label: 'Person' },
  { value: 'LOC', label: 'Location' },
  { value: 'ORG', label: 'Organization' },
];

export default function NerSelectionBar({ wrapRef, onApply }) {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const elRef = useRef(null);
  const visible = state.nerSelectedIds.size > 0 && state.tab === 'ner';

  // Default the type to the most-common existing entity type in the selection,
  // falling back to PER.
  const dominantType = useMemo(() => {
    const counts = {};
    state.nerSelectedIds.forEach((id) => {
      const t = nerEntityType(state.wordById[id]);
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    let best = '';
    let bestN = 0;
    Object.keys(counts).forEach((k) => {
      if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    });
    return best || 'PER';
  }, [state.nerSelectedIds, state.wordById]);

  const [type, setType] = useState(dominantType);
  useEffect(() => { setType(dominantType); }, [dominantType]);

  // Show delete only when at least one selected word already has an entity label.
  const hasEntities = useMemo(() => {
    let found = false;
    state.nerSelectedIds.forEach((id) => {
      if (nerEntityType(state.wordById[id])) found = true;
    });
    return found;
  }, [state.nerSelectedIds, state.wordById]);

  const labelText = useMemo(() => {
    const ids = Array.from(state.nerSelectedIds);
    const words = ids.map((id) => state.wordById[id]).filter(Boolean);
    words.sort((a, b) => {
      if (a.line_num !== b.line_num) return (a.line_num || 0) - (b.line_num || 0);
      return (a.word_num || 0) - (b.word_num || 0);
    });
    let text = words.map((w) => w.corrected_text || w.ocr_text).join(' ');
    if (text.length > 40) text = text.substring(0, 37) + '…';
    return '"' + text + '"';
  }, [state.nerSelectedIds, state.wordById]);

  useLayoutEffect(() => {
    if (visible && elRef.current && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      elRef.current.style.left = rect.right - 8 + 'px';
      elRef.current.style.top = rect.top + 8 + 'px';
    }
  }, [visible, labelText, wrapRef]);

  const typeLabel = ENTITY_TYPES.find((t) => t.value === type)?.label || 'Person';

  return (
    <div id="ner-select-bar" ref={elRef} style={{ display: visible ? 'flex' : 'none' }}>
      <label id="ner-select-label">{labelText}</label>

      <div className="btn-group btn-group-sm" role="group">
        <button
          id="ner-select-apply"
          type="button"
          className="btn btn-primary"
          onClick={() => onApply(type)}
        >
          <i className="fa-solid fa-check me-1" />
          {typeLabel}
        </button>
        <button
          type="button"
          className="btn btn-primary dropdown-toggle dropdown-toggle-split"
          data-bs-toggle="dropdown"
          aria-expanded="false"
        >
          <span className="visually-hidden">More entity types</span>
        </button>
        <ul className="dropdown-menu">
          {ENTITY_TYPES.map((et) => (
            <li key={et.value}>
              <a
                className={'dropdown-item' + (et.value === type ? ' active' : '')}
                href="#"
                onClick={(e) => { e.preventDefault(); setType(et.value); onApply(et.value); }}
              >
                {et.label}
              </a>
            </li>
          ))}
        </ul>
      </div>

      {hasEntities && (
        <button
          id="ner-select-delete"
          className="btn btn-sm btn-outline-danger"
          onClick={() => onApply('NONE')}
        >
          <i className="fa-solid fa-trash me-1" />
          Delete
        </button>
      )}

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
