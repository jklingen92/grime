import { useState } from 'react';
import EntityNote from './EntityNote.jsx';
import EntityAccordion from './EntityAccordion.jsx';

const TYPE_COLORS = { PER: '#417690', LOC: '#5d7a3e', ORG: '#8b4513' };

export default function EntityDetail(props) {
  const {
    entityType, entityText, displayText, typeLabel,
    notes, docCount, docs,
    noteUpdateUrl, dismissUrl, csrfToken,
  } = props;

  const [dismissed, setDismissed] = useState(props.dismissed || false);
  const [dismissing, setDismissing] = useState(false);

  async function toggleDismiss() {
    setDismissing(true);
    try {
      const res = await fetch(dismissUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrfToken,
        },
        body: `type=${encodeURIComponent(entityType)}&text=${encodeURIComponent(entityText)}&dismissed=${!dismissed}`,
      });
      const data = await res.json();
      if (data.ok) setDismissed(data.dismissed);
    } finally {
      setDismissing(false);
    }
  }

  const badgeColor = TYPE_COLORS[entityType] || '#6c757d';

  return (
    <div className="py-2">
      {dismissed && (
        <div className="alert alert-warning py-2 small mb-3">
          <i className="fa-solid fa-ban me-2" />
          This entity is dismissed as a false positive.
        </div>
      )}

      {/* Header row */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <h2 className="h5 mb-0">{displayText}</h2>
        <span
          className="badge"
          style={{ background: badgeColor, fontSize: '.7em' }}
        >
          {typeLabel}
        </span>
        <span className="text-muted small ms-1">
          {docCount} document{docCount !== 1 ? 's' : ''}
        </span>
        <button
          className={`btn btn-sm ms-auto ${dismissed ? 'btn-outline-success' : 'btn-outline-secondary'}`}
          onClick={toggleDismiss}
          disabled={dismissing}
          title={dismissed ? 'Restore entity' : 'Dismiss as false positive'}
        >
          <i className={`fa-solid ${dismissed ? 'fa-rotate-left' : 'fa-ban'} me-1`} />
          {dismissed ? 'Restore' : 'Dismiss'}
        </button>
      </div>

      {/* Note editor */}
      <EntityNote
        initialNotes={notes}
        entityType={entityType}
        entityText={entityText}
        noteUpdateUrl={noteUpdateUrl}
        csrfToken={csrfToken}
      />

      {/* Document accordion */}
      <EntityAccordion docs={docs} />
    </div>
  );
}
