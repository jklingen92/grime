import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';

export default function ZoomControls({ onFit }) {
  const { zoomLevel } = useViewerState();
  const dispatch = useViewerDispatch();
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        onClick={() =>
          dispatch({ type: 'SET_ZOOM', zoomLevel: Math.max(zoomLevel - 0.25, 0.25) })
        }
      >
        <i className="fa-solid fa-magnifying-glass-minus" />
      </button>
      <span id="dp-zoom-label">{Math.round(zoomLevel * 100)}%</span>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        onClick={() =>
          dispatch({ type: 'SET_ZOOM', zoomLevel: Math.min(zoomLevel + 0.25, 4.0) })
        }
      >
        <i className="fa-solid fa-magnifying-glass-plus" />
      </button>
      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onFit}>
        <i className="fa-solid fa-expand me-1" />
        Fit
      </button>
    </>
  );
}
