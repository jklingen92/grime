// Side panel container: divider drag + render the panel for the active tab.

import { useRef, useEffect } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import OcrPanel from './OcrPanel.jsx';
import NerPanel from './NerPanel.jsx';
import AnnotationPanel from './AnnotationPanel.jsx';
import ImagePanel from './ImagePanel.jsx';

export default function SidePanel({ onAnnotationConfirmSave }) {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const dividerRef = useRef(null);

  useEffect(() => {
    const divider = dividerRef.current;
    if (!divider) return;
    let drag = null;
    function onDown(e) {
      e.preventDefault();
      drag = { startX: e.clientX, startWidth: state.sidePanelWidth };
    }
    function onMove(e) {
      if (!drag) return;
      const next = Math.max(120, drag.startWidth - (e.clientX - drag.startX));
      dispatch({ type: 'SET_SIDE_PANEL_WIDTH', width: next });
    }
    function onUp() {
      drag = null;
    }
    divider.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      divider.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dispatch, state.sidePanelWidth]);

  const sharedStyle = { width: state.sidePanelWidth + 'px' };

  return (
    <>
      <div id="dp-divider" ref={dividerRef} />
      <div style={sharedStyle}>
        {state.tab === 'ocr' && <OcrPanel />}
        {state.tab === 'ner' && <NerPanel />}
        {state.tab === 'label' && <AnnotationPanel onConfirmSave={onAnnotationConfirmSave} />}
        {state.tab === 'image' && <ImagePanel />}
      </div>
    </>
  );
}
