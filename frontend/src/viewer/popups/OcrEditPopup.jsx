// Floating popup for editing the selected word(s) or naming a freshly drawn
// region. Calls back into the parent (ViewerApp) for the actual save logic
// so undo/redo state stays in one place.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useViewerState } from '../state/ViewerContext.jsx';

export default function OcrEditPopup({ popup, wrapRef, onClose, onConfirm, onSave, onDitto, onDelete, onRestore }) {
  const inputRef = useRef(null);
  const elRef = useRef(null);
  const state = useViewerState();

  useLayoutEffect(() => {
    if (popup && elRef.current && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      elRef.current.style.left = rect.right - 8 + 'px';
      elRef.current.style.top = rect.top + 8 + 'px';
    }
  }, [popup, wrapRef]);

  useEffect(() => {
    if (popup && inputRef.current) {
      inputRef.current.focus();
      if (popup.mode === 'single-edit') inputRef.current.select();
    }
  }, [popup]);

  if (!popup) return null;

  const count = state.ocrSelectedIds.size;
  const isDraw = popup.mode === 'draw';
  const isMulti = popup.mode === 'multi-edit';
  const word = popup.word;

  function getInputValue() {
    return inputRef.current?.value || '';
  }

  function handleConfirm() {
    if (isDraw) {
      const t = getInputValue().trim();
      onSave(t);
      return;
    }
    const text = getInputValue().trim();
    if (text === '') onConfirm();
    else onSave(text);
  }

  const anyCorrection = !isDraw && Array.from(state.ocrSelectedIds).some(
    (id) => !!(state.wordById[id] && state.wordById[id].corrected_text),
  );

  return (
    <div id="ocr-popup" ref={elRef} style={{ display: 'block' }}>
      <div className="ocr-popup-header">
        <span id="ocr-popup-title">
          {isDraw ? 'New region' : count === 1 ? '1 word selected' : count + ' words selected'}
        </span>
        <button
          id="ocr-popup-close"
          className="ocr-popup-close-btn"
          title="Close (Esc)"
          onClick={onClose}
        >
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
      {!isDraw && count === 1 && word && (
        <div className="ocr-popup-original" id="ocr-popup-original">
          Original: {word.ocr_text}
        </div>
      )}
      <input
        ref={inputRef}
        type="text"
        id="ocr-popup-input"
        defaultValue={!isDraw && count === 1 && word ? word.corrected_text || '' : ''}
        placeholder={
          isDraw
            ? 'Text for new region…'
            : isMulti
              ? 'Replace all with…'
              : 'Corrected text…'
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleConfirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="ocr-popup-actions">
        {!isDraw && (
          <button
            id="ocr-popup-confirm"
            className="btn btn-sm btn-primary"
            onClick={() => onConfirm()}
          >
            <i className="fa-solid fa-check me-1" />
            Confirm
          </button>
        )}
        <button
          id="ocr-popup-ditto"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => onDitto()}
        >
          <i className="fa-solid fa-copy me-1" />
          Ditto
        </button>
        {!isDraw && anyCorrection && (
          <button
            id="ocr-popup-restore"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onRestore()}
          >
            <i className="fa-solid fa-rotate-left me-1" />
            Restore
          </button>
        )}
        {!isDraw && (
          <button
            id="ocr-popup-delete"
            className="btn btn-sm btn-outline-danger"
            onClick={() => onDelete()}
          >
            <i className="fa-solid fa-trash me-1" />
            Delete
          </button>
        )}
        <span className="ocr-popup-hint">Enter · Esc</span>
      </div>
    </div>
  );
}
