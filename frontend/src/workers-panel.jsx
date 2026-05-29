import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import WorkerCard from './WorkerCard.jsx';

const { statusUrl, cancelUrlTpl, csrfToken, jobsListUrl, workerSlots } =
  window.DOC_LIST_CONFIG;

function NoSlotsMessage() {
  return (
    <div className="col-12">
      <p className="text-muted small">
        No worker slots configured. Set <code>GRIME_WORKER_SLOTS</code> in your
        environment and run <code>python manage.py migrate</code> to seed the
        slots automatically.
      </p>
    </div>
  );
}

function WorkersPanel() {
  const [slots, setSlots] = useState(
    (workerSlots ?? []).map(s => ({ ...s, job: null, pendingCount: 0 }))
  );
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch(statusUrl);
        if (!res.ok) return;
        const data = await res.json();
        setPendingCount(data.pending_count ?? 0);
        setSlots(prev =>
          prev.map(s => {
            const live = (data.slots ?? []).find(
              ls => ls.slot_number === s.slotNumber
            );
            return live
              ? { ...s, job: live.job ?? null, pendingCount: live.pending_count ?? 0 }
              : s;
          })
        );
      } catch {}
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  function cancelJob(pk) {
    fetch(cancelUrlTpl.replace('{pk}', pk), {
      method: 'POST',
      headers: { 'X-CSRFToken': csrfToken },
    });
    // optimistic update — next poll confirms
    setSlots(prev =>
      prev.map(s => (s.job?.pk === pk ? { ...s, job: null } : s))
    );
  }

  return (
    <>
      <div className="d-flex align-items-center gap-2 mb-2">
        <span className="fw-semibold" style={{ color: 'var(--grime-primary)' }}>
          Workers
        </span>
        <span className="badge bg-secondary" id="pending-count-badge">
          {pendingCount} pending
        </span>
        <a
          href={jobsListUrl}
          className="btn btn-sm btn-outline-secondary ms-1"
        >
          <i className="fa-solid fa-list me-1" />All jobs
        </a>
        <button
          className="btn btn-sm btn-grime ms-auto"
          data-bs-toggle="modal"
          data-bs-target="#addJobModal"
        >
          <i className="fa-solid fa-plus me-1" />Add Job
        </button>
      </div>
      <div className="row g-3">
        {slots.length === 0 ? (
          <NoSlotsMessage />
        ) : (
          slots.map(s => (
            <WorkerCard key={s.slotNumber} slot={s} onCancel={cancelJob} />
          ))
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById('workers-panel-root')).render(
  <WorkersPanel />
);
