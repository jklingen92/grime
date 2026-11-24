// Side panel container: divider drag + render the panel for the active tab.

import { useRef, useEffect } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import OcrPanel from './OcrPanel.jsx';
import NerPanel from './NerPanel.jsx';
import AnnotationPanel from './AnnotationPanel.jsx';
import ImagePanel from './ImagePanel.jsx';

export default function SidePanel() {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const dividerRef = useRef(null);

  // The drag and the latest width live in refs so the listeners are bound
  // once; re-binding on every width change would reset the drag mid-gesture.
  const dragRef = useRef(null);
  const widthRef = useRef(state.sidePanelWidth);
  widthRef.current = state.sidePanelWidth;

  useEffect(() => {
    const divider = dividerRef.current;
    if (!divider) return;
    function onDown(e) {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: widthRef.current };
    }
    function onMove(e) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(120, drag.startWidth - (e.clientX - drag.startX));
      dispatch({ type: 'SET_SIDE_PANEL_WIDTH', width: next });
    }
    function onUp() {
      dragRef.current = null;
    }
    divider.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      divider.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dispatch]);

  const sharedStyle = { width: state.sidePanelWidth + 'px' };

  return (
    <>
      <div id="dp-divider" ref={dividerRef} />
      <div style={sharedStyle}>
        {state.tab === 'ocr' && <OcrPanel />}
        {state.tab === 'ner' && <NerPanel />}
        {state.tab === 'label' && <AnnotationPanel />}
        {state.tab === 'image' && <ImagePanel />}
      </div>
    </>
  );
}
