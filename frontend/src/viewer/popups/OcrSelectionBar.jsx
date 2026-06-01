// Floating action bar for multi-word OCR selections (2+ words).

import { useLayoutEffect, useRef } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';

export default function OcrSelectionBar({ wrapRef, popupOpen, onBulkDitto, onBulkDelete }) {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const elRef = useRef(null);
  const n = state.ocrSelectedIds.size;
  const visible = n >= 2 && state.tab === 'ocr' && !popupOpen;

  useLayoutEffect(() => {
    if (visible && elRef.current && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      elRef.current.style.left = rect.right - 8 + 'px';
      elRef.current.style.top = rect.top + 8 + 'px';
    }
  }, [visible, n, wrapRef]);

  return (
    <div id="ocr-merge-bar" ref={elRef} style={{ display: visible ? 'flex' : 'none' }}>
      <label id="ocr-merge-label">{n} words selected</label>
      <button
        id="ocr-bulk-ditto"
        className="btn btn-sm btn-outline-secondary"
        onClick={onBulkDitto}
      >
        <i className="fa-solid fa-copy me-1" />
        Ditto
      </button>
      <button
        id="ocr-bulk-delete"
        className="btn btn-sm btn-outline-danger"
        onClick={onBulkDelete}
      >
        <i className="fa-solid fa-trash me-1" />
        Delete
      </button>
      <button
        id="ocr-merge-cancel"
        className="btn btn-sm btn-outline-secondary"
        onClick={() => dispatch({ type: 'OCR_SELECT_CLEAR' })}
      >
        <i className="fa-solid fa-xmark me-1" />
        Cancel
      </button>
      <span className="merge-bar-hint">Esc · ⌫</span>
    </div>
  );
}
