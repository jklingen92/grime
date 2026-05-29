import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';

const TABS = [
  { key: 'ocr', label: 'OCR', icon: 'fa-font' },
  { key: 'ner', label: 'NER', icon: 'fa-tag' },
  { key: 'label', label: 'Label', icon: 'fa-bookmark' },
  { key: 'image', label: 'Image', icon: 'fa-image' },
];

export default function TabBar() {
  const { tab } = useViewerState();
  const dispatch = useViewerDispatch();
  return (
    <div id="dp-tabs" className="nav nav-tabs">
      {TABS.map((t) => (
        <button
          key={t.key}
          id={'tab-' + t.key}
          className={'dp-tab nav-link' + (tab === t.key ? ' active' : '')}
          onClick={() => dispatch({ type: 'SET_TAB', tab: t.key })}
        >
          <i className={'fa-solid ' + t.icon + ' me-1'} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
