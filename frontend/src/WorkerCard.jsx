export default function WorkerCard({ slot, onCancel }) {
  const { name, job, pendingCount } = slot;

  let content;
  if (job) {
    const pct = job.pages_total ? Math.round((job.pages_done / job.pages_total) * 100) : 0;
    const badgeCls = job.status === 'running' ? 'bg-primary' : 'bg-warning text-dark';
    content = (
      <>
        <div className="d-flex align-items-center gap-2">
          <div
            className="spinner-border spinner-border-sm text-primary"
            role="status"
            style={{ width: '.7rem', height: '.7rem', borderWidth: '2px' }}
          >
            <span className="visually-hidden">Running</span>
          </div>
          <span className={`badge ${badgeCls}`}>{job.job_type_label} {job.status}</span>
          <span className="text-truncate small flex-grow-1" title={job.document}>
            {job.document}
          </span>
          <button
            className="btn-close ms-auto"
            style={{ fontSize: '.55rem' }}
            aria-label="Cancel"
            onClick={() => onCancel(job.pk)}
          />
        </div>
        {job.pages_total > 0 && (
          <>
            <div className="progress mt-1" style={{ height: '4px' }}>
              <div
                className="progress-bar"
                role="progressbar"
                style={{ width: `${pct}%` }}
                aria-valuenow={job.pages_done}
                aria-valuemin={0}
                aria-valuemax={job.pages_total}
              />
            </div>
            <div className="text-muted" style={{ fontSize: '10px' }}>
              {job.pages_done}/{job.pages_total} pages
            </div>
          </>
        )}
      </>
    );
  } else if (pendingCount > 0) {
    content = (
      <span className="badge bg-secondary">{pendingCount} pending</span>
    );
  } else {
    content = <span className="text-muted">Idle</span>;
  }

  return (
    <div className="col-md-4">
      <div className="card worker-card">
        <div className="card-body py-2 px-3">
          <small
            className="text-muted fw-semibold text-uppercase d-block mb-2"
            style={{ fontSize: '10px' }}
          >
            {name}
          </small>
          <div className="slot-content text-muted small">{content}</div>
        </div>
      </div>
    </div>
  );
}
