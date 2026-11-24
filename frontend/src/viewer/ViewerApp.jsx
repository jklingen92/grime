// Top-level viewer component. Wires the toolbar, canvas, side panel,
// floating popups, and the per-page job modal. Owns the OCR popup state
// and the orchestration of network calls that span multiple slices
// (OCR mutations, NER bulk-label, image save, undo/redo, page nav).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from './state/ViewerContext.jsx';
import { isDirty, isIdentity, slidersToParams } from './state/imageParams.js';
import {
  addWord,
  bulkDeleteWords,
  bulkMarkDitto,
  correctNerLabel,
  correctWord,
  deleteWord,
  markWordDitto,
  resetImage,
  saveImage,
} from './api/endpoints.js';

import ViewerToolbar from './toolbar/ViewerToolbar.jsx';
import ViewerCanvas from './canvas/ViewerCanvas.jsx';
import SidePanel from './panels/SidePanel.jsx';
import ImageFilterSvg from './canvas/ImageFilterSvg.jsx';
import OcrEditPopup from './popups/OcrEditPopup.jsx';
import OcrSelectionBar from './popups/OcrSelectionBar.jsx';
import NerSelectionBar from './popups/NerSelectionBar.jsx';
import ImageUnsavedBar from './popups/ImageUnsavedBar.jsx';
import PageJobModal, { useJobPolling } from './jobs/PageJobModal.jsx';
import { useViewerNavigate } from './hooks/useViewerNavigate.js';

export default function ViewerApp() {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();

  const wrapRef = useRef(null);
  const coordElRef = useRef(null);
  // { mode: 'selection' } | { mode: 'draw', pendingRegion }. Selection contents
  // are derived below from the live selection, never stored, so they can't go stale.
  const [ocrPopup, setOcrPopup] = useState(null);
  const [jobModal, setJobModal] = useState({ visible: false, jobType: '' });
  const [activeJobs, setActiveJobs] = useState({}); // { ocr: jobPk, ner: jobPk }
  const [unsavedBar, setUnsavedBar] = useState(null); // { onContinue }

  const navigate = useViewerNavigate(state.tab);

  // ── OCR popup helpers ──
  const closeOcrPopup = useCallback(() => {
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
  }, [dispatch]);

  // Called right after a selection dispatch, before that state lands, so it
  // only marks the popup open; what it shows comes from the next render.
  const openOcrPopupForSelection = useCallback(() => {
    if (!config.hasRepair) return;
    setOcrPopup((prev) => (prev?.mode === 'draw' ? prev : { mode: 'selection' }));
  }, [config.hasRepair]);

  // Close the selection popup once nothing is selected.
  useEffect(() => {
    if (ocrPopup?.mode === 'selection' && state.ocrSelectedIds.size === 0) setOcrPopup(null);
  }, [state.ocrSelectedIds, ocrPopup]);

  // What OcrEditPopup renders: draw as stored, selection resolved to
  // single-edit (with the current word) or multi-edit.
  const ocrPopupView = useMemo(() => {
    if (ocrPopup?.mode !== 'selection') return ocrPopup;
    const ids = Array.from(state.ocrSelectedIds);
    if (ids.length === 1) return { mode: 'single-edit', word: state.wordById[ids[0]] };
    if (ids.length > 1) return { mode: 'multi-edit' };
    return null;
  }, [ocrPopup, state.ocrSelectedIds, state.wordById]);

  const openOcrPopupForDraw = useCallback((pending) => {
    setOcrPopup({ mode: 'draw', pendingRegion: pending });
  }, []);

  // ── Word primitives: server call + reducer update, no history. Shared by
  // the UI actions below (which record history) and undo/redo (which doesn't).

  function applyOcrUpdated(updates) {
    if (!updates || !updates.length) return;
    dispatch({ type: 'WORDS_PATCH', updates });
  }

  // changes: [{ wordId, text }]; '' or null clears the correction.
  // Returns the ids the server accepted.
  async function setCorrections(changes) {
    const done = [];
    for (const { wordId, text } of changes) {
      const data = await correctWord(config, wordId, text ?? '');
      if (!data.ok) continue;
      dispatch({ type: 'WORD_PATCH', id: wordId, patch: { corrected_text: data.corrected_text || null } });
      applyOcrUpdated(data.updated);
      done.push(wordId);
    }
    return done;
  }

  // Returns the deleted ids.
  async function removeWords(ids) {
    if (ids.length === 1) {
      const data = await deleteWord(config, ids[0]);
      if (!data.ok) return [];
      dispatch({ type: 'WORD_DELETE', id: data.deleted_id });
      applyOcrUpdated(data.updated);
      return [data.deleted_id];
    }
    const data = await bulkDeleteWords(config, ids);
    if (!data.ok) return [];
    dispatch({ type: 'WORDS_DELETE_BULK', ids: data.deleted_ids });
    applyOcrUpdated(data.updated);
    return data.deleted_ids;
  }

  // Re-create deleted words from snapshots. The add endpoint only takes a
  // bbox and text, so the text comes back as a correction on line 0 (the
  // original ocr_text, confidence and reading order are not restored).
  // Returns the new ids.
  async function restoreWords(snaps) {
    const ids = [];
    for (const snap of snaps) {
      const data = await addWord(config, snap, snap.corrected_text || snap.ocr_text);
      if (!data.ok) continue;
      dispatch({ type: 'WORD_ADD', word: data.word });
      dispatch({ type: 'HISTORY_REMAP_ID', from: snap.id, to: data.word.id });
      applyOcrUpdated(data.updated);
      ids.push(data.word.id);
    }
    return ids;
  }

  // Returns [{ wordId, prevText }] for the words marked, to undo with.
  async function markDittos(ids) {
    if (!ids.length) return [];
    const prevText = Object.fromEntries(
      ids.map((id) => [id, state.wordById[id]?.corrected_text || state.wordById[id]?.ocr_text || '']),
    );
    const data = ids.length === 1 ? await markWordDitto(config, ids[0]) : await bulkMarkDitto(config, ids);
    if (!data.ok) return [];
    const marked = data.marked_pks || [data.word_pk];
    marked.forEach((id) =>
      dispatch({ type: 'WORD_PATCH', id, patch: { ocr_text: '"', corrected_text: null, is_ditto: false } }),
    );
    applyOcrUpdated(data.updated);
    return marked.map((id) => ({ wordId: id, prevText: prevText[id] }));
  }

  // labels: [{ wordId, label }] with correctNerLabel's null / '' / value
  // meaning. Returns the ids the server accepted.
  async function setNerLabels(labels) {
    const done = [];
    for (const { wordId, label } of labels) {
      const data = await correctNerLabel(config, wordId, label);
      if (!data?.ok) continue;
      dispatch({ type: 'WORD_PATCH', id: wordId, patch: { corrected_label: label } });
      done.push(wordId);
    }
    return done;
  }

  function record(entry) {
    dispatch({ type: 'PUSH_UNDO', entry });
  }

  // ── OCR save / confirm / ditto / delete / restore actions ──

  // Set each selected word's correction to text(word) as one undo step.
  async function correctSelection(text) {
    const ids = Array.from(state.ocrSelectedIds).filter((id) => state.wordById[id]);
    if (!ids.length) return;
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    const changes = ids.map((id) => ({
      wordId: id,
      prev: state.wordById[id].corrected_text ?? null,
      next: text(state.wordById[id]),
    }));
    const done = await setCorrections(changes.map((c) => ({ wordId: c.wordId, text: c.next })));
    if (done.length) record({ type: 'ocr-correct', changes: changes.filter((c) => done.includes(c.wordId)) });
  }

  // Confirm as-is: pin the current text as a correction.
  function onOcrConfirm() {
    return correctSelection((w) => w.corrected_text || w.ocr_text);
  }

  function onOcrRestore() {
    return correctSelection(() => '');
  }

  async function onOcrSave(text) {
    if (ocrPopup?.mode === 'draw') {
      const pending = ocrPopup.pendingRegion;
      setOcrPopup(null);
      dispatch({ type: 'SET_DRAW_MODE', active: false });
      if (!text) return;
      const data = await addWord(config, pending, text);
      if (!data.ok) return;
      dispatch({ type: 'WORD_ADD', word: data.word });
      applyOcrUpdated(data.updated);
      record({ type: 'ocr-add', wordIds: [data.word.id] });
      return;
    }
    return correctSelection(() => text);
  }

  async function onOcrDelete() {
    const ids = Array.from(state.ocrSelectedIds).filter((id) => state.wordById[id]);
    if (!ids.length) return;
    if (ids.length > 1 && !confirm('Delete ' + ids.length + ' words?')) return;
    const snaps = ids.map((id) => ({ ...state.wordById[id] }));
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    const deleted = await removeWords(ids);
    if (deleted.length) record({ type: 'ocr-delete', words: snaps.filter((w) => deleted.includes(w.id)) });
  }

  async function onOcrDitto() {
    if (ocrPopup?.mode === 'draw') {
      // Add the region empty, then mark it a ditto. Undo removes the region.
      const pending = ocrPopup.pendingRegion;
      setOcrPopup(null);
      dispatch({ type: 'SET_DRAW_MODE', active: false });
      const data = await addWord(config, pending, '');
      if (!data.ok) return;
      dispatch({ type: 'WORD_ADD', word: data.word });
      applyOcrUpdated(data.updated);
      record({ type: 'ocr-add', wordIds: [data.word.id] });
      await markDittos([data.word.id]);
      return;
    }
    const ids = Array.from(state.ocrSelectedIds);
    if (!ids.length) return;
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    const changes = await markDittos(ids);
    if (changes.length) record({ type: 'ocr-ditto', changes });
  }

  // ── NER apply ──
  // type: 'PER' / 'LOC' / 'ORG', or 'NONE' to explicitly clear the label.
  async function onNerApply(type) {
    const ids = Array.from(state.nerSelectedIds).filter((id) => state.wordById[id]);
    if (!ids.length || !type) return;
    ids.sort((a, b) => {
      const wa = state.wordById[a];
      const wb = state.wordById[b];
      if (wa.left !== wb.left) return wa.left - wb.left;
      return wa.top - wb.top;
    });
    const changes = ids.map((id, idx) => ({
      wordId: id,
      prev: state.wordById[id].corrected_label ?? null,
      next: type === 'NONE' ? '' : (idx === 0 ? 'B-' : 'I-') + type,
    }));
    dispatch({ type: 'NER_SELECT_CLEAR' });
    const done = await setNerLabels(changes.map((c) => ({ wordId: c.wordId, label: c.next })));
    if (done.length) record({ type: 'ner-correct', changes: changes.filter((c) => done.includes(c.wordId)) });
  }

  // ── Undo / redo ──
  // Each handler reverts one entry and returns the entry that reverts it back,
  // so the same table serves both directions.
  const swap = (changes) => changes.map((c) => ({ ...c, prev: c.next, next: c.prev }));
  const historyHandlers = {
    'ocr-correct': async (e) => {
      const done = await setCorrections(e.changes.map((c) => ({ wordId: c.wordId, text: c.prev })));
      return { type: 'ocr-correct', changes: swap(e.changes.filter((c) => done.includes(c.wordId))) };
    },
    'ocr-add': async (e) => {
      const snaps = e.wordIds.map((id) => state.wordById[id]).filter(Boolean).map((w) => ({ ...w }));
      const deleted = await removeWords(snaps.map((w) => w.id));
      return { type: 'ocr-delete', words: snaps.filter((w) => deleted.includes(w.id)) };
    },
    'ocr-delete': async (e) => ({ type: 'ocr-add', wordIds: await restoreWords(e.words) }),
    // Like the legacy viewer, undoing a ditto re-applies each word's prior
    // text as a correction rather than restoring the raw ocr_text.
    'ocr-ditto': async (e) => {
      const done = await setCorrections(e.changes.map((c) => ({ wordId: c.wordId, text: c.prevText })));
      return { type: 'ocr-redo-ditto', wordIds: done };
    },
    'ocr-redo-ditto': async (e) => ({ type: 'ocr-ditto', changes: await markDittos(e.wordIds) }),
    'ner-correct': async (e) => {
      const done = await setNerLabels(e.changes.map((c) => ({ wordId: c.wordId, label: c.prev })));
      return { type: 'ner-correct', changes: swap(e.changes.filter((c) => done.includes(c.wordId))) };
    },
    'image-adjust': async (e) => {
      dispatch({ type: 'IMAGE_SET_CURRENT', params: e.prev });
      return { type: 'image-adjust', prev: e.next, next: e.prev };
    },
  };

  // One replay at a time: entries hold word ids that the previous replay
  // may still be remapping.
  const historyBusyRef = useRef(false);
  async function applyHistory(direction) {
    const stack = direction === 'undo' ? state.undoStack : state.redoStack;
    if (historyBusyRef.current || !stack.length) return;
    const entry = stack[stack.length - 1];
    const handler = historyHandlers[entry.type];
    historyBusyRef.current = true;
    dispatch({ type: direction === 'undo' ? 'POP_UNDO' : 'POP_REDO' });
    try {
      const inverse = handler ? await handler(entry) : null;
      if (inverse) {
        dispatch({ type: direction === 'undo' ? 'PUSH_REDO' : 'PUSH_REDO_TO_UNDO', entry: inverse });
      }
    } finally {
      historyBusyRef.current = false;
    }
  }

  // ── Annotation labeling entry ──
  function onOpenAnnotationLabeling(bbox, existingTag) {
    if (existingTag) {
      dispatch({
        type: 'ANNOTATION_EDITOR_ENTER_LABELING',
        bbox: {
          left: existingTag.bbox_left,
          top: existingTag.bbox_top,
          width: existingTag.bbox_width,
          height: existingTag.bbox_height,
        },
        editingId: existingTag.id,
        label: existingTag.label,
        subcomponents: existingTag.subcomponents || [],
      });
    } else if (bbox) {
      dispatch({
        type: 'ANNOTATION_EDITOR_ENTER_LABELING',
        bbox,
        editingId: null,
        label: '',
        subcomponents: [],
      });
    }
  }

  // ── Image save / unsaved-bar gating ──
  async function onSaveImage() {
    const params = slidersToParams(state.image.current);
    try {
      const data = isIdentity(params) ? await resetImage(config) : await saveImage(config, params);
      if (!data.ok) {
        alert(data.error || 'Save failed.');
        return false;
      }
      dispatch({
        type: 'IMAGE_MARK_SAVED',
        params: state.image.current,
        hasCorrected: !isIdentity(params),
      });
      if (data.image_url) {
        const sep = data.image_url.indexOf('?') >= 0 ? '&' : '?';
        config.imageUrl = data.image_url + sep + 't=' + Date.now();
      }
      return true;
    } catch (err) {
      alert('Save failed: ' + (err?.message || err));
      return false;
    }
  }

  function ensureImageSaved(onContinue) {
    if (!isDirty(state.image.current, state.image.saved)) {
      onContinue();
      return;
    }
    setUnsavedBar({ onContinue });
  }

  // ── Fit ──
  const onFit = useCallback(() => {
    const img = document.getElementById('dp-img');
    const wrap = wrapRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight || !wrap) return;
    const aw = wrap.parentElement.clientWidth - 4;
    const ah = Math.round(window.innerHeight * 0.8) - 4;
    const z = Math.min(1.0, (aw / img.naturalWidth + ah / img.naturalHeight) / 2);
    dispatch({ type: 'SET_ZOOM', zoomLevel: z });
  }, [dispatch]);

  // ── Job modal lifecycle ──
  function openJobModal(jobType) {
    setJobModal({ visible: true, jobType });
  }

  function onJobStarted(jobPk, jobType) {
    setJobModal({ visible: false, jobType: '' });
    setActiveJobs((cur) => ({ ...cur, [jobType]: jobPk }));
  }

  const onJobComplete = useCallback((type, status) => {
    setActiveJobs((cur) => {
      const next = { ...cur };
      delete next[type];
      return next;
    });
    if (status === 'complete') window.location.reload();
  }, []);

  useJobPolling(config, activeJobs, onJobComplete);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    function inInputField() {
      const t = document.activeElement && document.activeElement.tagName;
      return (
        (t === 'INPUT' && document.activeElement.type !== 'range') ||
        t === 'TEXTAREA' ||
        (document.activeElement && document.activeElement.isContentEditable)
      );
    }
    function onKey(e) {
      const inField = inInputField();
      if (e.key === 'ArrowLeft' && !inField && config.prevUrl) {
        navigate(config.prevUrl);
        return;
      }
      if (e.key === 'ArrowRight' && !inField && config.nextUrl) {
        navigate(config.nextUrl);
        return;
      }
      if (config.hasRepair && (e.ctrlKey || e.metaKey) && !inField) {
        // e.key is 'Z' with Shift held on most layouts.
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          applyHistory('undo');
          return;
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault();
          applyHistory('redo');
          return;
        }
      }
      if (state.tab === 'ocr' && config.hasRepair) {
        if (e.key === 'Escape') {
          if (ocrPopup) setOcrPopup(null);
          else dispatch({ type: 'OCR_SELECT_CLEAR' });
          if (state.drawMode) dispatch({ type: 'SET_DRAW_MODE', active: false });
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !inField && e.key === 'a') {
          e.preventDefault();
          const ids = state.words.map((w) => w.id).filter((id) => id != null);
          dispatch({ type: 'OCR_SELECT_REPLACE', ids });
          return;
        }
        if (!inField && e.key === 'a') {
          e.preventDefault();
          dispatch({ type: 'SET_DRAW_MODE', active: !state.drawMode });
          return;
        }
        if (
          !inField &&
          (e.key === 'Delete' || e.key === 'Backspace') &&
          state.ocrSelectedIds.size >= 2
        ) {
          e.preventDefault();
          onOcrDelete();
          return;
        }
      }
      if (state.tab === 'ner' && e.key === 'Escape') {
        dispatch({ type: 'NER_SELECT_CLEAR' });
      }
      if (state.tab === 'label' && state.annotation.phase === 'labeling') {
        if (e.key === 'Escape' && !inField) {
          e.preventDefault();
          dispatch({ type: 'ANNOTATION_EDITOR_EXIT' });
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Global click to close popup / clear selection ──
  useEffect(() => {
    function onClick(e) {
      if (e.shiftKey) return;
      const inViewer = !!e.target.closest('#dp-viewer');
      const inPopup = !!e.target.closest('#ocr-popup');
      const inMergeBar = !!e.target.closest('#ocr-merge-bar');
      const inTextPanel = !!e.target.closest('#dp-text-panel');
      const inNerBar = !!e.target.closest('#ner-select-bar');

      if (state.tab === 'ocr') {
        if (ocrPopup && !inPopup && !inViewer && !inMergeBar && !inTextPanel) {
          setOcrPopup(null);
        }
        if (!inViewer && !inMergeBar && !inTextPanel && !inPopup) {
          dispatch({ type: 'OCR_SELECT_CLEAR' });
        }
      }
      if (state.tab === 'ner') {
        if (!inViewer && !inNerBar) dispatch({ type: 'NER_SELECT_CLEAR' });
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [state.tab, ocrPopup, dispatch]);

  return (
    <>
      <ImageFilterSvg sliders={state.image.current} />
      <div style={{ marginBottom: '1.5em' }}>
        <ViewerToolbar
          onFit={onFit}
          onOpenJobModal={openJobModal}
          jobRunning={{
            ocr: !!activeJobs.ocr,
            ner: !!activeJobs.ner,
          }}
          onSaveImage={onSaveImage}
        />

        <div id="dp-outer">
          <ViewerCanvas
            wrapRef={wrapRef}
            onCoordChange={(c) => {
              const el = coordElRef.current;
              if (!el) return;
              if (!c) {
                el.style.display = 'none';
                return;
              }
              el.textContent = c.x + ', ' + c.y;
              el.style.display = 'block';
              if (wrapRef.current) {
                const wr = wrapRef.current.getBoundingClientRect();
                el.style.left = wr.right - el.offsetWidth - 8 + 'px';
                el.style.top = wr.bottom - el.offsetHeight - 8 + 'px';
              }
            }}
            onOpenOcrPopupForSelection={openOcrPopupForSelection}
            onOpenOcrPopupForDraw={openOcrPopupForDraw}
            onOpenAnnotationLabeling={onOpenAnnotationLabeling}
          />
          <SidePanel />
        </div>
      </div>
      <div id="dp-coord" ref={coordElRef} />

      <OcrEditPopup
        popup={ocrPopupView}
        wrapRef={wrapRef}
        onClose={closeOcrPopup}
        onConfirm={onOcrConfirm}
        onSave={onOcrSave}
        onDitto={onOcrDitto}
        onDelete={onOcrDelete}
        onRestore={onOcrRestore}
      />
      <OcrSelectionBar
        wrapRef={wrapRef}
        popupOpen={!!ocrPopupView}
        onBulkDitto={onOcrDitto}
        onBulkDelete={onOcrDelete}
      />
      <NerSelectionBar wrapRef={wrapRef} onApply={onNerApply} />
      <ImageUnsavedBar
        visible={!!unsavedBar}
        wrapRef={wrapRef}
        onSave={async () => {
          const ok = await onSaveImage();
          const cb = unsavedBar?.onContinue;
          setUnsavedBar(null);
          if (ok && cb) cb();
        }}
        onSkip={() => {
          const cb = unsavedBar?.onContinue;
          setUnsavedBar(null);
          if (cb) cb();
        }}
        onCancel={() => setUnsavedBar(null)}
      />

      <PageJobModal
        visible={jobModal.visible}
        jobType={jobModal.jobType}
        confirmedWordCount={config.confirmedWordCount}
        onClose={() => setJobModal({ visible: false, jobType: '' })}
        onJobStarted={onJobStarted}
      />
    </>
  );
}
