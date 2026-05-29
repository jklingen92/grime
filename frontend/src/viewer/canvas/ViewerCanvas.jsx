// The image canvas: <img>, overlays, rubber-band/draw rectangles, and the
// per-tab mouse gesture dispatch. Side-effect refs are used only to drive
// the rubber-band rect DOM during a drag (then committed via the reducer).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { useScale } from '../hooks/useScale.js';
import { computeImageStyle } from './imageStyle.js';
import OcrOverlay from './OcrOverlay.jsx';
import NerOverlay from './NerOverlay.jsx';
import AnnotationOverlay from './AnnotationOverlay.jsx';
import { dist, updateRubberBandRect, viewerOffsetFor, wordsInRect } from './canvasGesture.js';

const MOVE_THRESHOLD = 5;
const DRAW_MIN = 4;
const ANNOTATION_MIN = 10;

export default function ViewerCanvas({
  wrapRef,
  onCoordChange,
  onOpenOcrPopupForSelection,
  onOpenOcrPopupForDraw,
  onOpenAnnotationLabeling,
}) {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();

  const viewerRef = useRef(null);
  const imgRef = useRef(null);
  const drawRectRef = useRef(null);
  const selectRectRef = useRef(null);
  const annotationDrawRectRef = useRef(null);
  const annotationSubRectRef = useRef(null);
  const annotationActiveRectRef = useRef(null);
  const veilTopRef = useRef(null);
  const veilBottomRef = useRef(null);
  const veilLeftRef = useRef(null);
  const veilRightRef = useRef(null);

  const { scale, recompute } = useScale(imgRef, config.usePreprocessedBbox);

  const [imgNaturalReady, setImgNaturalReady] = useState(false);

  // Gesture state lives in refs so we don't re-render on each mousemove.
  const gestureRef = useRef(null);

  // ── compute initial fit ──
  useEffect(() => {
    function fit() {
      const img = imgRef.current;
      const wrap = wrapRef.current;
      if (!img || !img.naturalWidth || !img.naturalHeight || !wrap) return;
      const aw = wrap.parentElement.clientWidth - 4;
      const ah = Math.round(window.innerHeight * 0.8) - 4;
      const z = Math.min(1.0, (aw / img.naturalWidth + ah / img.naturalHeight) / 2);
      dispatch({ type: 'SET_ZOOM', zoomLevel: z });
      recompute();
    }
    if (imgNaturalReady) fit();
  }, [imgNaturalReady, dispatch, recompute]);

  // ── update veils when annotation pending bbox changes ──
  useEffect(() => {
    if (state.annotation.phase !== 'labeling' || !state.annotation.pendingBbox) {
      [veilTopRef, veilBottomRef, veilLeftRef, veilRightRef].forEach((r) => {
        if (r.current) r.current.style.display = 'none';
      });
      if (annotationActiveRectRef.current) annotationActiveRectRef.current.style.display = 'none';
      return;
    }
    const viewer = viewerRef.current;
    if (!viewer) return;
    const bx = Math.round(state.annotation.pendingBbox.left * scale);
    const by = Math.round(state.annotation.pendingBbox.top * scale);
    const bw = Math.round(state.annotation.pendingBbox.width * scale);
    const bh = Math.round(state.annotation.pendingBbox.height * scale);
    const vw = viewer.offsetWidth;
    const vh = viewer.offsetHeight;
    function setVeil(ref, l, t, w, h) {
      if (!ref.current) return;
      const el = ref.current;
      el.style.left = l + 'px';
      el.style.top = t + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.display = w > 0 && h > 0 ? 'block' : 'none';
    }
    setVeil(veilTopRef, 0, 0, vw, by);
    setVeil(veilBottomRef, 0, by + bh, vw, Math.max(0, vh - by - bh));
    setVeil(veilLeftRef, 0, by, bx, bh);
    setVeil(veilRightRef, bx + bw, by, Math.max(0, vw - bx - bw), bh);
    if (annotationActiveRectRef.current) {
      const ar = annotationActiveRectRef.current;
      ar.style.left = bx + 'px';
      ar.style.top = by + 'px';
      ar.style.width = bw + 'px';
      ar.style.height = bh + 'px';
      ar.style.display = 'block';
    }
  }, [state.annotation.phase, state.annotation.pendingBbox, scale]);

  // ── apply zoom by setting img width ──
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    img.style.width = Math.round(img.naturalWidth * state.zoomLevel) + 'px';
    recompute();
  }, [state.zoomLevel, recompute]);

  // ── apply image src/filter/transform from sliders ──
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const style = computeImageStyle(
      state.image.current,
      state.image.saved,
      state.image.hasCorrected,
      config.imageUrl,
      config.originalImageUrl,
    );
    if (style.src && img.getAttribute('src') !== style.src) {
      img.setAttribute('src', style.src);
    }
    img.style.filter = style.filter;
    img.style.transform = style.transform;
  }, [state.image, config.imageUrl, config.originalImageUrl]);

  // ── wheel zoom + coord readout ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onWheel(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      dispatch({
        type: 'SET_ZOOM',
        zoomLevel:
          e.deltaY < 0
            ? Math.min(state.zoomLevel + 0.25, 4.0)
            : Math.max(state.zoomLevel - 0.25, 0.25),
      });
    }
    function onMove(e) {
      const img = imgRef.current;
      if (!img) return;
      const r = img.getBoundingClientRect();
      const ix = e.clientX - r.left;
      const iy = e.clientY - r.top;
      if (ix < 0 || iy < 0 || ix > r.width || iy > r.height) {
        onCoordChange?.(null);
      } else {
        onCoordChange?.({
          x: Math.round(ix / scale),
          y: Math.round(iy / scale),
        });
      }
    }
    function onLeave() {
      onCoordChange?.(null);
    }
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('mouseleave', onLeave);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('mousemove', onMove);
      wrap.removeEventListener('mouseleave', onLeave);
    };
  }, [dispatch, scale, state.zoomLevel, onCoordChange]);

  // ── mouse gesture dispatch ──
  function onMouseDownDispatch(e) {
    // Corner-resize handles intercept first.
    if (e.target.classList && e.target.classList.contains('dp-annotation-corner')) {
      if (state.annotation.phase !== 'labeling' || !state.annotation.pendingBbox) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({
        type: 'ANNOTATION_SET_RESIZING',
        resizing: {
          corner: e.target.dataset.corner,
          startX: e.clientX,
          startY: e.clientY,
          startBbox: { ...state.annotation.pendingBbox },
        },
      });
      gestureRef.current = { type: 'annotation-resize' };
      return;
    }

    if (state.tab === 'ocr') {
      if (state.drawMode) {
        e.preventDefault();
        const origin = viewerOffsetFor(viewerRef.current, e);
        const dr = drawRectRef.current;
        if (dr) {
          dr.style.left = origin.x + 'px';
          dr.style.top = origin.y + 'px';
          dr.style.width = '0px';
          dr.style.height = '0px';
          dr.style.display = 'block';
        }
        gestureRef.current = { type: 'ocr-draw', origin };
      } else {
        e.preventDefault();
        gestureRef.current = {
          type: 'ocr-select',
          startX: e.clientX,
          startY: e.clientY,
          target: e.target,
          dragging: false,
          shiftKey: e.shiftKey,
        };
      }
    } else if (state.tab === 'ner') {
      e.preventDefault();
      gestureRef.current = {
        type: 'ner-select',
        startX: e.clientX,
        startY: e.clientY,
        target: e.target,
        dragging: false,
        shiftKey: e.shiftKey,
      };
    } else if (state.tab === 'label') {
      if (state.annotation.phase === 'draw') {
        e.preventDefault();
        gestureRef.current = {
          type: 'annotation-draw',
          startX: e.clientX,
          startY: e.clientY,
          target: e.target,
          dragging: false,
        };
      } else if (state.annotation.phase === 'labeling') {
        const ghost = e.target.closest ? e.target.closest('.dp-word-ghost') : null;
        if (!ghost) {
          e.preventDefault();
          gestureRef.current = {
            type: 'annotation-sub-select',
            startX: e.clientX,
            startY: e.clientY,
            target: e.target,
            dragging: false,
            shiftKey: e.shiftKey,
          };
        } else {
          gestureRef.current = {
            type: 'annotation-ghost-click',
            target: e.target,
            shiftKey: e.shiftKey,
          };
        }
      }
    }
  }

  useEffect(() => {
    function onMove(e) {
      const g = gestureRef.current;
      if (!g) return;
      const viewer = viewerRef.current;
      if (!viewer) return;
      const vr = viewer.getBoundingClientRect();

      if (g.type === 'annotation-resize') {
        const r = state.annotation.resizing;
        if (!r) return;
        const dx = (e.clientX - r.startX) / scale;
        const dy = (e.clientY - r.startY) / scale;
        const b = r.startBbox;
        let nb = { left: b.left, top: b.top, width: b.width, height: b.height };
        const MIN = ANNOTATION_MIN;
        switch (r.corner) {
          case 'tl':
            nb.left = Math.round(b.left + dx);
            nb.top = Math.round(b.top + dy);
            nb.width = Math.max(MIN, Math.round(b.width - dx));
            nb.height = Math.max(MIN, Math.round(b.height - dy));
            if (nb.width === MIN) nb.left = b.left + b.width - MIN;
            if (nb.height === MIN) nb.top = b.top + b.height - MIN;
            break;
          case 'tr':
            nb.top = Math.round(b.top + dy);
            nb.width = Math.max(MIN, Math.round(b.width + dx));
            nb.height = Math.max(MIN, Math.round(b.height - dy));
            if (nb.height === MIN) nb.top = b.top + b.height - MIN;
            break;
          case 'bl':
            nb.left = Math.round(b.left + dx);
            nb.width = Math.max(MIN, Math.round(b.width - dx));
            nb.height = Math.max(MIN, Math.round(b.height + dy));
            if (nb.width === MIN) nb.left = b.left + b.width - MIN;
            break;
          case 'br':
            nb.width = Math.max(MIN, Math.round(b.width + dx));
            nb.height = Math.max(MIN, Math.round(b.height + dy));
            break;
          default:
            break;
        }
        dispatch({ type: 'ANNOTATION_SET_PENDING_BBOX', bbox: nb });
        return;
      }

      if (g.type === 'ocr-draw') {
        const pos = viewerOffsetFor(viewer, e);
        const dr = drawRectRef.current;
        if (!dr) return;
        dr.style.left = Math.min(pos.x, g.origin.x) + 'px';
        dr.style.top = Math.min(pos.y, g.origin.y) + 'px';
        dr.style.width = Math.abs(pos.x - g.origin.x) + 'px';
        dr.style.height = Math.abs(pos.y - g.origin.y) + 'px';
        return;
      }

      if (g.type === 'ocr-select' || g.type === 'ner-select') {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.dragging && dist(dx, dy) > MOVE_THRESHOLD) {
          g.dragging = true;
          if (!e.shiftKey) {
            if (g.type === 'ocr-select') dispatch({ type: 'OCR_SELECT_CLEAR' });
            else dispatch({ type: 'NER_SELECT_CLEAR' });
          }
        }
        if (g.dragging) {
          updateRubberBandRect(
            selectRectRef.current,
            g.startX,
            g.startY,
            e.clientX,
            e.clientY,
            vr,
          );
        }
        return;
      }

      if (g.type === 'annotation-draw') {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.dragging && dist(dx, dy) > MOVE_THRESHOLD) g.dragging = true;
        if (g.dragging) {
          updateRubberBandRect(
            annotationDrawRectRef.current,
            g.startX,
            g.startY,
            e.clientX,
            e.clientY,
            vr,
          );
        }
        return;
      }

      if (g.type === 'annotation-sub-select') {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.dragging && dist(dx, dy) > MOVE_THRESHOLD) g.dragging = true;
        if (g.dragging) {
          updateRubberBandRect(
            annotationSubRectRef.current,
            g.startX,
            g.startY,
            e.clientX,
            e.clientY,
            vr,
          );
        }
        return;
      }
    }

    function onUp(e) {
      const g = gestureRef.current;
      if (!g) return;
      const viewer = viewerRef.current;
      if (!viewer) {
        gestureRef.current = null;
        return;
      }
      const vr = viewer.getBoundingClientRect();

      if (g.type === 'annotation-resize') {
        // Bbox change is recorded via undo when the user clicks Save; we don't
        // record bbox-change undo entries for live resizes here (the legacy
        // viewer-annotation.js:460 did record one — TODO).
        gestureRef.current = null;
        dispatch({ type: 'ANNOTATION_SET_RESIZING', resizing: null });
        return;
      }

      if (g.type === 'ocr-draw') {
        const pos = viewerOffsetFor(viewer, e);
        const dx = Math.min(pos.x, g.origin.x);
        const dy = Math.min(pos.y, g.origin.y);
        const dw = Math.abs(pos.x - g.origin.x);
        const dh = Math.abs(pos.y - g.origin.y);
        const dr = drawRectRef.current;
        gestureRef.current = null;
        if (dw < DRAW_MIN || dh < DRAW_MIN) {
          if (dr) dr.style.display = 'none';
          dispatch({ type: 'SET_DRAW_MODE', active: false });
          return;
        }
        const pending = {
          left: Math.round(dx / scale),
          top: Math.round(dy / scale),
          width: Math.round(dw / scale),
          height: Math.round(dh / scale),
        };
        onOpenOcrPopupForDraw?.(pending);
        return;
      }

      if (g.type === 'ocr-select') {
        if (g.dragging) {
          const x1 = Math.min(g.startX, e.clientX) - vr.left;
          const y1 = Math.min(g.startY, e.clientY) - vr.top;
          const x2 = Math.max(g.startX, e.clientX) - vr.left;
          const y2 = Math.max(g.startY, e.clientY) - vr.top;
          const hits = wordsInRect(state.words, scale, x1, y1, x2, y2);
          const hitIds = hits.map((w) => w.id);
          if (e.shiftKey) {
            dispatch({ type: 'OCR_SELECT_ADD', ids: hitIds });
          } else {
            dispatch({ type: 'OCR_SELECT_REPLACE', ids: hitIds });
          }
          if (selectRectRef.current) selectRectRef.current.style.display = 'none';
          if (hitIds.length > 0) onOpenOcrPopupForSelection?.();
        } else {
          const wordEl = g.target.closest ? g.target.closest('.ocr-word') : null;
          if (wordEl && wordEl.dataset.wordId) {
            const wid = parseInt(wordEl.dataset.wordId, 10);
            if (e.shiftKey) {
              dispatch({ type: 'OCR_SELECT_TOGGLE', id: wid });
              onOpenOcrPopupForSelection?.();
            } else {
              dispatch({ type: 'OCR_SELECT_REPLACE', ids: [wid] });
              onOpenOcrPopupForSelection?.();
            }
          } else if (!e.shiftKey) {
            dispatch({ type: 'OCR_SELECT_CLEAR' });
          }
        }
        gestureRef.current = null;
        e.stopPropagation();
        return;
      }

      if (g.type === 'ner-select') {
        if (g.dragging) {
          const x1 = Math.min(g.startX, e.clientX) - vr.left;
          const y1 = Math.min(g.startY, e.clientY) - vr.top;
          const x2 = Math.max(g.startX, e.clientX) - vr.left;
          const y2 = Math.max(g.startY, e.clientY) - vr.top;
          const hits = wordsInRect(state.words, scale, x1, y1, x2, y2);
          const hitIds = hits.map((w) => w.id);
          if (e.shiftKey) dispatch({ type: 'NER_SELECT_ADD', ids: hitIds });
          else dispatch({ type: 'NER_SELECT_REPLACE', ids: hitIds });
          if (selectRectRef.current) selectRectRef.current.style.display = 'none';
        } else {
          const nerEl = g.target.closest ? g.target.closest('.dp-ner-overlay') : null;
          if (nerEl && nerEl.dataset.wordIds) {
            const wordIds = nerEl.dataset.wordIds.split(',').map(Number);
            if (e.shiftKey) {
              dispatch({ type: 'NER_SELECT_TOGGLE_MANY', ids: wordIds });
            } else {
              dispatch({ type: 'NER_SELECT_REPLACE', ids: wordIds });
            }
          } else if (!e.shiftKey) {
            dispatch({ type: 'NER_SELECT_CLEAR' });
          }
        }
        gestureRef.current = null;
        e.stopPropagation();
        return;
      }

      if (g.type === 'annotation-draw') {
        if (annotationDrawRectRef.current) annotationDrawRectRef.current.style.display = 'none';
        if (g.dragging) {
          const px = Math.min(g.startX, e.clientX) - vr.left;
          const py = Math.min(g.startY, e.clientY) - vr.top;
          let pw = Math.abs(e.clientX - g.startX);
          let ph = Math.abs(e.clientY - g.startY);
          let lx = px;
          let ly = py;
          pw = Math.max(0, pw - Math.max(0, -lx));
          ph = Math.max(0, ph - Math.max(0, -ly));
          lx = Math.max(0, lx);
          ly = Math.max(0, ly);
          if (pw > DRAW_MIN && ph > DRAW_MIN) {
            const bbox = {
              left: Math.round(lx / scale),
              top: Math.round(ly / scale),
              width: Math.round(pw / scale),
              height: Math.round(ph / scale),
            };
            onOpenAnnotationLabeling?.(bbox);
          }
        } else {
          // Plain click: try to open an existing annotation.
          const cpx = (e.clientX - vr.left) / scale;
          const cpy = (e.clientY - vr.top) / scale;
          const hit = state.annotations.find(
            (t) =>
              cpx >= t.bbox_left &&
              cpy >= t.bbox_top &&
              cpx <= t.bbox_left + t.bbox_width &&
              cpy <= t.bbox_top + t.bbox_height,
          );
          if (hit) onOpenAnnotationLabeling?.(null, hit);
        }
        gestureRef.current = null;
        e.stopPropagation();
        return;
      }

      if (g.type === 'annotation-sub-select') {
        if (annotationSubRectRef.current) annotationSubRectRef.current.style.display = 'none';
        if (g.dragging && state.annotation.pendingBbox) {
          const x1 = Math.min(g.startX, e.clientX) - vr.left;
          const y1 = Math.min(g.startY, e.clientY) - vr.top;
          const x2 = Math.max(g.startX, e.clientX) - vr.left;
          const y2 = Math.max(g.startY, e.clientY) - vr.top;
          const rb = state.annotation.pendingBbox;
          const hits = wordsInRect(state.words, scale, x1, y1, x2, y2).filter(
            (w) =>
              w.left >= rb.left - 4 &&
              w.top >= rb.top - 4 &&
              w.left + w.width <= rb.left + rb.width + 4 &&
              w.top + w.height <= rb.top + rb.height + 4,
          );
          const ids = hits.map((w) => w.id);
          if (e.shiftKey) {
            const cur = new Set(state.annotation.subSelectedIds);
            ids.forEach((id) => cur.add(id));
            dispatch({ type: 'ANNOTATION_SET_SUB_SELECTED', ids: Array.from(cur) });
          } else {
            dispatch({ type: 'ANNOTATION_SET_SUB_SELECTED', ids });
          }
        }
        gestureRef.current = null;
        e.stopPropagation();
        return;
      }

      if (g.type === 'annotation-ghost-click') {
        const ghost = g.target.closest ? g.target.closest('.dp-word-ghost') : null;
        if (ghost && ghost.dataset.wordId && state.annotation.pendingBbox) {
          const wid = parseInt(ghost.dataset.wordId, 10);
          const w = state.wordById[wid];
          const rb = state.annotation.pendingBbox;
          const inside =
            w &&
            !(
              w.left < rb.left ||
              w.top < rb.top ||
              w.left + w.width > rb.left + rb.width + 4 ||
              w.top + w.height > rb.top + rb.height + 4
            );
          if (inside) {
            if (e.shiftKey) {
              dispatch({ type: 'ANNOTATION_TOGGLE_SUB_SELECTED', id: wid });
            } else {
              dispatch({ type: 'ANNOTATION_SET_SUB_SELECTED', ids: [wid] });
            }
          }
        }
        gestureRef.current = null;
        e.stopPropagation();
        return;
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [
    dispatch,
    state.tab,
    state.drawMode,
    state.annotation,
    state.words,
    state.wordById,
    state.annotations,
    scale,
    onOpenOcrPopupForSelection,
    onOpenOcrPopupForDraw,
    onOpenAnnotationLabeling,
  ]);

  const viewerCls = useMemo(() => {
    const parts = [];
    if (state.boxesHidden) parts.push('hide-boxes');
    if (state.tab === 'ocr' && state.drawMode) parts.push('draw-mode');
    return parts.join(' ');
  }, [state.boxesHidden, state.drawMode, state.tab]);

  return (
    <div id="dp-viewer-wrap" ref={wrapRef}>
      <div id="dp-viewer" ref={viewerRef} className={viewerCls} onMouseDown={onMouseDownDispatch}>
        <img
          id="dp-img"
          ref={imgRef}
          alt={config.imageAlt || ''}
          onLoad={() => setImgNaturalReady(true)}
        />
        <div id="dp-draw-rect" ref={drawRectRef} />
        <div id="dp-select-rect" ref={selectRectRef} />
        <div id="dp-annotation-draw-rect" ref={annotationDrawRectRef} />
        <div id="dp-annotation-active-rect" ref={annotationActiveRectRef}>
          <div className="dp-annotation-corner tl" data-corner="tl" />
          <div className="dp-annotation-corner tr" data-corner="tr" />
          <div className="dp-annotation-corner bl" data-corner="bl" />
          <div className="dp-annotation-corner br" data-corner="br" />
        </div>
        <div id="dp-annotation-sub-rect" ref={annotationSubRectRef} />
        <div id="dp-veil-top" className="dp-veil" ref={veilTopRef} style={{ display: 'none' }} />
        <div id="dp-veil-bottom" className="dp-veil" ref={veilBottomRef} style={{ display: 'none' }} />
        <div id="dp-veil-left" className="dp-veil" ref={veilLeftRef} style={{ display: 'none' }} />
        <div id="dp-veil-right" className="dp-veil" ref={veilRightRef} style={{ display: 'none' }} />

        {state.tab === 'ocr' && <OcrOverlay scale={scale} hasRepair={config.hasRepair} />}
        {state.tab === 'ner' && <NerOverlay scale={scale} />}
        {state.tab === 'label' && <AnnotationOverlay scale={scale} />}
      </div>
    </div>
  );
}
