// Two views in one panel:
//   list-view  — saved annotations, click to open in label-view
//   label-view — pending bbox label + subcomp editor + save/cancel/delete

import { useEffect, useMemo, useRef } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import {
  createAnnotation,
  deleteAnnotation,
  updateAnnotation,
} from '../api/endpoints.js';

const DITTO_RE = /^["'«»''""″〃〞＂]+$/;

function isDitto(text) {
  const t = (text || '').trim();
  return DITTO_RE.test(t) || t === '""' || t === "''" || t === '``';
}

function resolveDitto(annotations, label, currentTop) {
  const candidates = annotations
    .filter((t) => t.bbox_top + t.bbox_height <= currentTop + 8)
    .slice()
    .sort((a, b) => b.bbox_top - a.bbox_top);
  for (const c of candidates) {
    const sc = (c.subcomponents || []).find((s) => s.label === label);
    if (sc && sc.text && !isDitto(sc.text)) return sc.text;
  }
  return null;
}

export default function AnnotationPanel({ onConfirmSave }) {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const labelInputRef = useRef(null);
  const subInputRef = useRef(null);

  const phase = state.annotation.phase;
  const editingId = state.annotation.editingId;
  const pendingBbox = state.annotation.pendingBbox;
  const subSelectedIds = state.annotation.subSelectedIds;
  const pendingSubcomps = state.annotation.pendingSubcomps;

  // datalist of seen labels.
  const seenLabels = useMemo(() => {
    const seen = {};
    state.annotations.forEach((t) => {
      (t.subcomponents || []).forEach((sc) => {
        if (sc.label) seen[sc.label] = true;
      });
    });
    pendingSubcomps.forEach((sc) => {
      if (sc.label) seen[sc.label] = true;
    });
    return Object.keys(seen).sort();
  }, [state.annotations, pendingSubcomps]);

  // Focus the label input on entering labeling mode.
  useEffect(() => {
    if (phase === 'labeling') {
      const t = setTimeout(() => {
        const el = labelInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 0);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const commonSelectedLabel = useMemo(() => {
    let seen = null;
    let all = true;
    subSelectedIds.forEach((wid) => {
      const sc = pendingSubcomps.find((s) => s.word_id === wid);
      if (!sc) {
        all = false;
        return;
      }
      if (seen === null) seen = sc.label;
      else if (seen !== sc.label) all = false;
    });
    return all && seen !== null ? seen : '';
  }, [subSelectedIds, pendingSubcomps]);

  function confirmSubLabel() {
    const label = (subInputRef.current?.value || '').trim();
    if (!label || !subSelectedIds.size) return;
    const next = pendingSubcomps.slice();
    subSelectedIds.forEach((wid) => {
      const w = state.wordById[wid];
      if (!w) return;
      const existing = next.find((s) => s.word_id === wid);
      if (existing) {
        existing.label = label;
      } else {
        let text = w.corrected_text || w.ocr_text || '';
        if (isDitto(text) && pendingBbox) {
          const resolved = resolveDitto(state.annotations, label, pendingBbox.top);
          if (resolved) text = resolved;
        }
        next.push({ word_id: wid, label, text });
      }
    });
    dispatch({ type: 'ANNOTATION_SET_SUBCOMPS', subcomps: next });
    dispatch({ type: 'ANNOTATION_SET_SUB_SELECTED', ids: [] });
    if (subInputRef.current) subInputRef.current.value = '';
  }

  function removeSubcompByWordId(wid) {
    const next = pendingSubcomps.filter((s) => s.word_id !== wid);
    dispatch({ type: 'ANNOTATION_SET_SUBCOMPS', subcomps: next });
  }

  function clearSubcompForSelection() {
    const next = pendingSubcomps.filter((s) => !subSelectedIds.has(s.word_id));
    dispatch({ type: 'ANNOTATION_SET_SUBCOMPS', subcomps: next });
    dispatch({ type: 'ANNOTATION_SET_SUB_SELECTED', ids: [] });
    if (subInputRef.current) subInputRef.current.value = '';
  }

  async function onSave() {
    const label = (labelInputRef.current?.value || '').trim();
    if (!label || !pendingBbox) {
      labelInputRef.current?.focus();
      return;
    }
    const fields = {
      label,
      bbox_left: pendingBbox.left,
      bbox_top: pendingBbox.top,
      bbox_width: pendingBbox.width,
      bbox_height: pendingBbox.height,
      subcomponents: pendingSubcomps.slice(),
    };
    try {
      let data;
      if (editingId) {
        data = await updateAnnotation(config, editingId, fields);
      } else {
        data = await createAnnotation(config, fields);
      }
      if (!data.ok) {
        alert(data.error || 'Error saving label.');
        return;
      }
      if (editingId) {
        dispatch({ type: 'ANNOTATION_REPLACE', annotation: data.annotation });
      } else {
        dispatch({ type: 'ANNOTATION_ADD', annotation: data.annotation });
      }
      dispatch({ type: 'ANNOTATION_EDITOR_EXIT' });
      onConfirmSave?.();
    } catch (err) {
      alert('Save failed: ' + (err?.message || err));
    }
  }

  async function onDelete() {
    if (!editingId) return;
    if (!confirm('Delete this label?')) return;
    const data = await deleteAnnotation(config, editingId);
    if (!data.ok) {
      alert('Error deleting label.');
      return;
    }
    dispatch({ type: 'ANNOTATION_DELETE', id: editingId });
    dispatch({ type: 'ANNOTATION_EDITOR_EXIT' });
  }

  function onCancel() {
    dispatch({ type: 'ANNOTATION_EDITOR_EXIT' });
  }

  function openExisting(tag) {
    dispatch({
      type: 'ANNOTATION_EDITOR_ENTER_LABELING',
      bbox: { left: tag.bbox_left, top: tag.bbox_top, width: tag.bbox_width, height: tag.bbox_height },
      editingId: tag.id,
      label: tag.label,
      subcomponents: tag.subcomponents || [],
    });
  }

  const showSubInput = subSelectedIds.size > 0;

  return (
    <div id="dp-annotation-panel" className="visible">
      <div id="dp-annotation-list-view" style={{ display: phase === 'labeling' ? 'none' : '' }}>
        <h3>Labels</h3>
        <div id="dp-annotation-instructions">
          <span>Drag on image to create a label.</span>
          <span>Click anywhere on a label to edit it.</span>
        </div>
        <div id="dp-annotation-list">
          {!state.annotations.length ? (
            <div id="dp-annotation-empty">No labels yet.</div>
          ) : (
            state.annotations.map((t) => (
              <div
                key={t.id}
                className="dp-annotation-item"
                data-tag-id={t.id}
                onClick={() => openExisting(t)}
              >
                <div>{t.label}</div>
                {t.subcomponents && t.subcomponents.length > 0 && (
                  <div className="dp-annotation-item-sub">
                    {t.subcomponents.map((s) => s.label + ': ' + s.text).join(' · ')}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div
        id="dp-annotation-label-view"
        style={{ display: phase === 'labeling' ? 'flex' : 'none' }}
      >
        <h3 id="dp-annotation-label-heading">{editingId ? 'Edit label' : 'New label'}</h3>
        <input
          id="dp-annotation-label-input"
          ref={labelInputRef}
          type="text"
          className="form-control form-control-sm"
          placeholder="Label…"
          autoComplete="off"
          defaultValue={state.annotation.pendingLabel}
        />
        <div
          id="dp-annotation-sub-input-row"
          style={{ display: showSubInput ? '' : 'none' }}
        >
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              id="dp-annotation-sub-input"
              ref={subInputRef}
              type="text"
              list="dp-sub-label-list"
              className="form-control form-control-sm"
              placeholder="Label for selection…"
              autoComplete="off"
              defaultValue={commonSelectedLabel}
              key={`${commonSelectedLabel}-${subSelectedIds.size}`}
              style={{ flex: 1, minWidth: 0 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmSubLabel();
                }
              }}
            />
            <button
              id="dp-annotation-sub-clear-btn"
              type="button"
              className="btn btn-sm btn-outline-danger"
              title="Remove selected from pattern"
              style={{ flexShrink: 0 }}
              onClick={clearSubcompForSelection}
            >
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
          <datalist id="dp-sub-label-list">
            {seenLabels.map((lbl) => (
              <option key={lbl} value={lbl} />
            ))}
          </datalist>
          <div id="dp-annotation-sub-hint">Enter to label · × to remove · Esc to deselect</div>
        </div>
        <div id="dp-annotation-subcomp-list">
          {pendingSubcomps.map((sc) => {
            const isSelected = subSelectedIds.has(sc.word_id);
            return (
              <div
                key={sc.word_id}
                className={'dp-subcomp-row' + (isSelected ? ' highlighted' : '')}
                onClick={(e) => {
                  if (e.target.classList.contains('dp-subcomp-rm')) return;
                  dispatch({ type: 'ANNOTATION_TOGGLE_SUB_SELECTED', id: sc.word_id });
                }}
              >
                <span className="dp-subcomp-label">{sc.label}:</span>
                <span className="dp-subcomp-text">{sc.text}</span>
                <span
                  className="dp-subcomp-rm"
                  title="Remove from pattern"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSubcompByWordId(sc.word_id);
                  }}
                >
                  ×
                </span>
              </div>
            );
          })}
        </div>
        <div id="dp-annotation-actions">
          <button
            id="dp-annotation-save-btn"
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onSave}
          >
            <i className="fa-solid fa-floppy-disk me-1" />
            Save ↵
          </button>
          <button
            id="dp-annotation-cancel-btn"
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={onCancel}
          >
            <i className="fa-solid fa-xmark me-1" />
            Cancel ⎋
          </button>
          {editingId && (
            <button
              id="dp-annotation-delete-btn"
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={onDelete}
            >
              <i className="fa-solid fa-trash me-1" />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
