// Entity sidebar: grouped by type with collapsible sections, click toggles
// state.nerHighlightKey to colour matching words on the canvas.

import { useMemo, useState } from 'react';
import { useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { groupedEntities } from '../state/selectors.js';

const TYPES = [
  { key: 'PER', label: 'Person' },
  { key: 'LOC', label: 'Location' },
  { key: 'ORG', label: 'Organization' },
];

export default function NerPanel() {
  const state = useViewerState();
  const dispatch = useViewerDispatch();
  const groups = useMemo(() => groupedEntities(state.words), [state.words]);

  const [collapsed, setCollapsed] = useState({});

  function toggleCollapse(t) {
    setCollapsed((c) => ({ ...c, [t]: !c[t] }));
  }

  function onItemClick(item) {
    const key = item.type + ':' + item.text.trim().toLowerCase();
    dispatch({
      type: 'NER_SET_HIGHLIGHT',
      key: state.nerHighlightKey === key ? null : key,
    });
  }

  return (
    <div id="dp-ner-panel" className="visible">
      <h3>Entities</h3>
      <div id="dp-ner-instructions">
        <span>Click a word to edit · drag or shift-click to multi-select.</span>
        <div id="dp-ner-legend-block">
          <span className="dp-ner-legend-title">NER highlights</span>
          <span>
            <span className="dp-ner-swatch ner-PER" />
            Person
          </span>
          <span>
            <span className="dp-ner-swatch ner-LOC" />
            Location
          </span>
          <span>
            <span className="dp-ner-swatch ner-ORG" />
            Organization
          </span>
        </div>
      </div>
      <div id="dp-ner-entity-list">
        {TYPES.map((t) => {
          const items = groups[t.key] || [];
          return (
            <div
              key={t.key}
              className={'dp-ner-section' + (collapsed[t.key] ? ' collapsed' : '')}
              data-type={t.key}
            >
              <div
                className="dp-ner-section-header"
                onClick={() => toggleCollapse(t.key)}
              >
                <span className="dp-ner-section-caret">▾</span> {t.label}{' '}
                <span className="dp-ner-section-count">({items.length})</span>
              </div>
              <div className="dp-ner-section-body">
                {!items.length ? (
                  <div className="dp-ner-entity-empty">No entities.</div>
                ) : (
                  items.map((item) => {
                    const key = item.type + ':' + item.text.trim().toLowerCase();
                    const isActive = state.nerHighlightKey === key;
                    return (
                      <div
                        key={key}
                        className={'dp-ner-entity-row ner-' + item.type + (isActive ? ' active' : '')}
                        onClick={() => onItemClick(item)}
                      >
                        <span className="dp-ner-entity-text">{item.text}</span>
                        <span className="dp-ner-entity-count">{item.count}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
