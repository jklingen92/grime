import { useState } from 'react';

export default function EntityNote({ initialNotes, entityType, entityText, noteUpdateUrl, csrfToken }) {
  const [notes, setNotes]   = useState(initialNotes || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]   = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(notes);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(noteUpdateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrfToken,
        },
        body: `type=${encodeURIComponent(entityType)}&text=${encodeURIComponent(entityText)}&notes=${encodeURIComponent(draft)}`,
      });
      const data = await res.json();
      if (data.ok) {
        setNotes(draft);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="d-flex align-items-start gap-2 mb-3">
        <textarea
          className="form-control form-control-sm"
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          style={{ resize: 'vertical', minWidth: 0, flex: 1 }}
        />
        <div className="d-flex flex-column gap-1">
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            <i className="fa-solid fa-floppy-disk me-1" />Save
          </button>
          <button className="btn btn-sm btn-outline-secondary" onClick={cancel} disabled={saving}>
            <i className="fa-solid fa-xmark me-1" />Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="d-flex align-items-start gap-2 mb-3">
      <span className={notes ? 'small' : 'small text-muted fst-italic'} style={{ flex: 1 }}>
        {notes || 'Add a note…'}
      </span>
      <button
        className="btn btn-sm btn-link p-0 text-muted"
        title="Edit note"
        onClick={startEdit}
        style={{ lineHeight: 1 }}
      >
        <i className="fa-solid fa-pencil" />
      </button>
    </div>
  );
}
