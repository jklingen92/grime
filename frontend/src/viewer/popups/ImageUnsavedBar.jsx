// Bar shown when the user tries to change pages/tabs with unsaved image
// adjustments. Three choices: save & continue, skip, cancel.

import { useLayoutEffect, useRef } from 'react';

export default function ImageUnsavedBar({ visible, wrapRef, onSave, onSkip, onCancel }) {
  const elRef = useRef(null);

  useLayoutEffect(() => {
    if (visible && elRef.current && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      elRef.current.style.left = rect.right - 8 + 'px';
      elRef.current.style.top = rect.top + 8 + 'px';
    }
  }, [visible, wrapRef]);

  return (
    <div id="dp-image-unsaved-bar" ref={elRef} style={{ display: visible ? 'flex' : 'none' }}>
      <label id="dp-image-unsaved-label">You have unsaved image adjustments.</label>
      <button id="dp-image-unsaved-save" className="btn btn-sm btn-primary" onClick={onSave}>
        <i className="fa-solid fa-floppy-disk me-1" />
        Save &amp; continue
      </button>
      <button
        id="dp-image-unsaved-skip"
        className="btn btn-sm btn-outline-secondary"
        onClick={onSkip}
      >
        <i className="fa-solid fa-clock-rotate-left me-1" />
        Use last-saved image
      </button>
      <button
        id="dp-image-unsaved-cancel"
        className="btn btn-sm btn-outline-secondary"
        onClick={onCancel}
      >
        <i className="fa-solid fa-xmark me-1" />
        Cancel
      </button>
    </div>
  );
}
