// Top-level viewer component. Wires the toolbar, canvas, side panel,
// floating popups, and the per-page job modal. Owns the OCR popup state
// and the orchestration of network calls that span multiple slices
// (OCR mutations, NER bulk-label, image save, undo/redo, page nav).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from './state/ViewerContext.jsx';
import { isDirty, slidersToParams } from './state/imageParams.js';
import {
  addWord,
  bulkDeleteWords,
  bulkMarkDitto,
  correctNerLabel,
  correctWord,
  createJob,
  deleteWord,
  markWordDitto,
  pollJob,
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
  const [ocrPopup, setOcrPopup] = useState(null); // { mode, word?, pendingRegion? }
  const [jobModal, setJobModal] = useState({ visible: false, jobType: '' });
  const [activeJobs, setActiveJobs] = useState({}); // { ocr: jobPk, ner: jobPk }
  const [unsavedBar, setUnsavedBar] = useState(null); // { onContinue }

  const navigate = useViewerNavigate(state.tab);

  // Persist the active tab in the URL so page reloads (e.g. after a job
  // completes) land on the same tab instead of always resetting to ocr.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', state.tab);
    history.replaceState(null, '', url);
  }, [state.tab]);

  // ── OCR popup helpers ──
  const closeOcrPopup = useCallback(() => {
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
  }, [dispatch]);

  const openOcrPopupForSelection = useCallback(() => {
    if (!config.hasRepair) return;
    setOcrPopup((prev) => {
      if (prev?.mode === 'draw') return prev;
      const ids = Array.from(state.ocrSelectedIds);
      if (ids.length === 1) {
        return { mode: 'single-edit', word: state.wordById[ids[0]] };
      }
      if (ids.length > 1) {
        return { mode: 'multi-edit' };
      }
      return null;
    });
  }, [config.hasRepair, state.ocrSelectedIds, state.wordById]);

  // Re-derive popup contents when selection changes while open.
  useEffect(() => {
    if (!ocrPopup || ocrPopup.mode === 'draw') return;
    const ids = Array.from(state.ocrSelectedIds);
    if (ids.length === 0) {
      setOcrPopup(null);
    } else if (ids.length === 1 && ocrPopup.mode !== 'single-edit') {
      setOcrPopup({ mode: 'single-edit', word: state.wordById[ids[0]] });
    } else if (ids.length > 1 && ocrPopup.mode !== 'multi-edit') {
      setOcrPopup({ mode: 'multi-edit' });
    }
  }, [state.ocrSelectedIds, state.wordById, ocrPopup]);

  const openOcrPopupForDraw = useCallback((pending) => {
    setOcrPopup({ mode: 'draw', pendingRegion: pending });
  }, []);

  // ── OCR save / confirm / ditto / delete / restore actions ──
  async function postCorrection(word, text, skipUndo) {
    if (!config.hasRepair) return;
    const prev = word.corrected_text;
    if (!skipUndo) {
      dispatch({
        type: 'PUSH_UNDO',
        entry: { type: 'ocr-correct', wordId: word.id, prev, next: text },
      });
    }
    const data = await correctWord(config, word.id, text ?? '');
    if (!data.ok) return;
    dispatch({
      type: 'WORD_PATCH',
      id: word.id,
      patch: { corrected_text: data.corrected_text || null },
    });
    applyOcrUpdated(data.updated);
  }

  function applyOcrUpdated(updates) {
    if (!updates || !updates.length) return;
    dispatch({ type: 'WORDS_PATCH', updates });
  }

  async function onOcrConfirm() {
    const ids = Array.from(state.ocrSelectedIds);
    if (!ids.length) return;
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    for (const id of ids) {
      const w = state.wordById[id];
      if (!w) continue;
      await postCorrection(w, w.corrected_text || w.ocr_text);
    }
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
      dispatch({
        type: 'PUSH_UNDO',
        entry: { type: 'ocr-add', wordId: data.word.id },
      });
      applyOcrUpdated(data.updated);
      return;
    }
    const ids = Array.from(state.ocrSelectedIds);
    if (!ids.length) return;
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    for (const id of ids) {
      const w = state.wordById[id];
      if (w) await postCorrection(w, text);
    }
  }

  async function onOcrDelete() {
    const ids = Array.from(state.ocrSelectedIds);
    if (!ids.length) return;
    if (ids.length === 1) {
      const id = ids[0];
      const w = state.wordById[id];
      if (!w) return;
      const snap = { ...w };
      setOcrPopup(null);
      dispatch({ type: 'OCR_SELECT_CLEAR' });
      const data = await deleteWord(config, id);
      if (!data.ok) return;
      dispatch({ type: 'WORD_DELETE', id: data.deleted_id });
      dispatch({
        type: 'PUSH_UNDO',
        entry: { type: 'ocr-delete', wordData: snap },
      });
      applyOcrUpdated(data.updated);
    } else {
      if (!confirm('Delete ' + ids.length + ' words?')) return;
      setOcrPopup(null);
      const data = await bulkDeleteWords(config, ids);
      if (!data.ok) return;
      dispatch({ type: 'WORDS_DELETE_BULK', ids: data.deleted_ids });
      applyOcrUpdated(data.updated);
    }
  }

  async function onOcrRestore() {
    const ids = Array.from(state.ocrSelectedIds).filter(
      (id) => !!(state.wordById[id] && state.wordById[id].corrected_text),
    );
    if (!ids.length) return;
    setOcrPopup(null);
    dispatch({ type: 'OCR_SELECT_CLEAR' });
    for (const id of ids) {
      const w = state.wordById[id];
      if (w) await postCorrection(w, '');
    }
  }

  async function onOcrDitto() {
    if (ocrPopup?.mode === 'draw') {
      // Add region as empty then mark ditto.
      const pending = ocrPopup.pendingRegion;
      setOcrPopup(null);
      dispatch({ type: 'SET_DRAW_MODE', active: false });
      const data = await addWord(config, pending, '');
      if (!data.ok) return;
      const word = data.word;
      dispatch({ type: 'WORD_ADD', word });
      dispatch({ type: 'PUSH_UNDO', entry: { type: 'ocr-add', wordId: word.id } });
      const data2 = await markWordDitto(config, word.id);
      if (data2.ok) {
        dispatch({
          type: 'WORD_PATCH',
          id: word.id,
          patch: { ocr_text: '"', corrected_text: null, is_ditto: true },
        });
        applyOcrUpdated(data2.updated);
      }
      return;
    }
    const ids = Array.from(state.ocrSelectedIds);
    if (!ids.length) return;
    setOcrPopup(null);
    if (ids.length > 1) {
      const data = await bulkMarkDitto(config, ids);
      if (!data.ok) return;
      data.marked_pks.forEach((id) => {
        dispatch({
          type: 'WORD_PATCH',
          id,
          patch: { ocr_text: '"', corrected_text: null, is_ditto: true },
        });
      });
      applyOcrUpdated(data.updated);
      dispatch({ type: 'OCR_SELECT_CLEAR' });
    } else {
      const id = ids[0];
      const data = await markWordDitto(config, id);
      if (!data.ok) return;
      dispatch({
        type: 'WORD_PATCH',
        id,
        patch: { ocr_text: '"', corrected_text: null, is_ditto: true },
      });
      applyOcrUpdated(data.updated);
      dispatch({ type: 'OCR_SELECT_CLEAR' });
    }
  }

  // ── NER apply ──
  async function onNerApply(type) {
    const ids = Array.from(state.nerSelectedIds);
    if (!ids.length) return;
    ids.sort((a, b) => {
      const wa = state.wordById[a];
      const wb = state.wordById[b];
      if (!wa || !wb) return 0;
      if (wa.left !== wb.left) return wa.left - wb.left;
      return wa.top - wb.top;
    });
    for (let idx = 0; idx < ids.length; idx++) {
      const id = ids[idx];
      const next = type === 'NONE' || !type ? null : (idx === 0 ? 'B-' : 'I-') + type;
      const data = await correctNerLabel(config, id, next);
      if (data?.ok) {
        // Mirror what the server stored: '' means "explicitly cleared", which
        // suppresses ner_label; null would fall back to it and resurrect the entity.
        dispatch({ type: 'WORD_PATCH', id, patch: { corrected_label: data.label } });
      }
    }
    dispatch({ type: 'NER_SELECT_CLEAR' });
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
    const url = isIdentityParams(params) ? config.imageResetUrl : config.imageSaveUrl;
    try {
      const data = isIdentityParams(params)
        ? await resetImage(config)
        : await saveImage(config, params);
      if (!data.ok) {
        alert(data.error || 'Save failed.');
        return false;
      }
      dispatch({
        type: 'IMAGE_MARK_SAVED',
        params: state.image.current,
        hasCorrected: !isIdentityParams(params),
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
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          /* TODO: undo */ return;
        }
        if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
          e.preventDefault();
          /* TODO: redo */ return;
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
      <div id="dp-person-confirm-strip" style={{ display: 'none' }} />
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

        <div id="dp-ner-progress-wrap">
          <div id="dp-ner-progress-bar" />
        </div>

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
        popup={ocrPopup}
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
        popupOpen={!!ocrPopup}
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

function isIdentityParams(p) {
  return (
    p.brightness === 0 &&
    p.contrast === 1 &&
    p.gamma === 1 &&
    p.black === 0 &&
    p.white === 255 &&
    !p.grayscale &&
    !p.invert &&
    p.threshold == null &&
    !p.sharpen &&
    !p.rotate90 &&
    !p.rotate_fine
  );
}
