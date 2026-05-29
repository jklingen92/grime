// Top toolbar: tab-specific actions + page nav + badges + image save button.

import { useMemo } from 'react';
import { useViewerConfig, useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { isDirty } from '../state/imageParams.js';
import TabBar from './TabBar.jsx';
import ZoomControls from './ZoomControls.jsx';
import PageNav from './PageNav.jsx';

export default function ViewerToolbar({
  onFit,
  onOpenJobModal,
  jobRunning,
  onSaveImage,
}) {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();

  const tab = state.tab;
  const hasRepair = !!config.hasRepair;

  const ocrBtnLabel = state.words.length ? 'Rerun OCR' : 'Run OCR';
  const nerBtnLabel = state.words.some((w) => w.ner_label || w.corrected_label)
    ? 'Rerun NER'
    : 'Run NER';

  const tabBadge = useMemo(() => {
    if (tab === 'label') {
      const n = state.annotations.length;
      return n ? n + ' label' + (n === 1 ? '' : 's') : 'No labels';
    }
    if (tab === 'ner') {
      const n = state.words.filter((w) => {
        const lbl = w.corrected_label || w.ner_label;
        return lbl && lbl.replace(/^[BI]-/, '');
      }).length;
      return n ? n + ' entity word' + (n === 1 ? '' : 's') : 'No NER data';
    }
    return state.words.length ? state.words.length + ' word' + (state.words.length === 1 ? '' : 's') : 'No OCR data';
  }, [tab, state.words, state.annotations]);

  const imageDirty = isDirty(state.image.current, state.image.saved);

  return (
    <>
      <TabBar />
      <div id="dp-toolbar" style={{ marginTop: 6 }}>
        <ZoomControls onFit={onFit} />

        {hasRepair && (
          <>
            <div className="dp-toolbar-sep" id="dp-sep-ocr" style={{ display: tab === 'ocr' ? '' : 'none' }} />
            <div id="dp-ocr-actions" className={tab === 'ocr' ? 'visible' : ''}>
              <button
                id="dp-rerun-ocr"
                type="button"
                className="btn btn-sm btn-outline-secondary"
                style={{ display: jobRunning.ocr ? 'none' : '' }}
                onClick={() => onOpenJobModal('ocr')}
              >
                <i className="fa-solid fa-gears me-1" />
                {ocrBtnLabel}
              </button>
              <span
                id="dp-rerun-ocr-spinner"
                className="dp-job-spinner"
                style={{ display: jobRunning.ocr ? '' : 'none' }}
                aria-label="OCR running"
              >
                <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />
                <span className="dp-job-spinner-text">Running…</span>
              </span>
              <button
                id="dp-boxes-toggle"
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => dispatch({ type: 'TOGGLE_BOXES' })}
              >
                {state.boxesHidden ? 'Show boxes' : 'Hide boxes'}
              </button>
              <button
                id="dp-draw-toggle"
                type="button"
                className="btn btn-sm btn-outline-secondary"
                style={{
                  background: state.drawMode ? '#e67e00' : '',
                  color: state.drawMode ? '#fff' : '',
                }}
                onClick={() => dispatch({ type: 'SET_DRAW_MODE', active: !state.drawMode })}
              >
                <i className="fa-solid fa-draw-polygon me-1" />
                {state.drawMode ? 'Cancel draw' : 'Add region (a)'}
              </button>
            </div>

            <div className="dp-toolbar-sep" id="dp-sep-ner" style={{ display: tab === 'ner' ? '' : 'none' }} />
            <div id="dp-ner-split" style={{ display: tab === 'ner' ? '' : 'none' }}>
              <button
                id="dp-rerun-ner"
                type="button"
                className="btn btn-sm btn-outline-secondary"
                style={{ display: jobRunning.ner ? 'none' : '' }}
                onClick={() => onOpenJobModal('ner')}
              >
                <i className="fa-solid fa-tags me-1" />
                {nerBtnLabel}
              </button>
              <span
                id="dp-rerun-ner-spinner"
                className="dp-job-spinner"
                style={{ display: jobRunning.ner ? '' : 'none' }}
                aria-label="NER running"
              >
                <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />
                <span className="dp-job-spinner-text">Running…</span>
              </span>
            </div>
          </>
        )}

        <div className="dp-toolbar-sep" />
        <PageNav />

        {state.docAnnotationCount != null && (
          <>
            <div className="dp-toolbar-sep" />
            <span
              id="dp-doc-annotation-count"
              title="Total annotations across all pages in this document"
              style={{ fontSize: '0.82em', color: '#555' }}
            >
              doc: <strong id="dp-doc-annotation-count-val">{state.docAnnotationCount}</strong>{' '}
              <span id="dp-doc-annotation-count-suffix">
                annotation{state.docAnnotationCount === 1 ? '' : 's'}
              </span>
            </span>
          </>
        )}

        <div className="dp-toolbar-sep" />
        <span id="dp-tab-badge" style={{ fontSize: '0.82em', color: '#666' }}>
          {tabBadge}
        </span>

        {config.exportPdfUrl && (
          <a
            href={config.exportPdfUrl}
            className="btn btn-sm btn-outline-secondary"
            style={{ marginLeft: 'auto' }}
            title="Download this page as a searchable PDF"
          >
            Export PDF
          </a>
        )}
        <button
          id="dp-image-save-btn"
          type="button"
          className="btn btn-sm btn-warning"
          style={{
            display: imageDirty ? '' : 'none',
            marginLeft: config.exportPdfUrl ? '' : 'auto',
          }}
          onClick={onSaveImage}
        >
          <i className="fa-solid fa-floppy-disk me-1" />
          Save adjusted image
        </button>
      </div>
    </>
  );
}
