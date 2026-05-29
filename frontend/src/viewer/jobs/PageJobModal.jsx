// Per-page Run-OCR / Run-NER modal. Uses Bootstrap's Modal class for
// show/hide so existing CSS and animations apply; React drives the form
// content and the polling effect.

import { useEffect, useRef, useState } from 'react';
import { useViewerConfig } from '../state/ViewerContext.jsx';
import {
  createJob,
  fetchJobFormFields,
  fetchJobsStatus,
  pollJob,
} from '../api/endpoints.js';

export default function PageJobModal({ visible, jobType, confirmedWordCount, onClose, onJobStarted }) {
  const config = useViewerConfig();
  const modalRef = useRef(null);
  const paramsRef = useRef(null);

  const [workerSlots, setWorkerSlots] = useState([]);
  const [selectedWorker, setSelectedWorker] = useState('');
  const [paramsHtml, setParamsHtml] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const Modal = window.bootstrap?.Modal;
    if (!Modal) return;
    const instance = Modal.getOrCreateInstance(el);
    if (visible) {
      instance.show();
    } else {
      instance.hide();
    }
    const onHidden = () => onClose?.();
    el.addEventListener('hidden.bs.modal', onHidden);
    return () => {
      el.removeEventListener('hidden.bs.modal', onHidden);
    };
  }, [visible, onClose]);

  useEffect(() => {
    if (!visible || !jobType) return;
    let cancelled = false;
    setError('');
    setSubmitting(false);

    // populate workers
    fetchJobsStatus(config)
      .then((data) => {
        if (cancelled) return;
        const slots = data?.slots || [];
        setWorkerSlots(slots);
        const firstIdle = slots.find((s) => !s.job && !s.pending_count);
        const pick = firstIdle?.pk ?? slots[0]?.pk ?? '';
        setSelectedWorker(String(pick));
      })
      .catch(() => {
        if (!cancelled) setWorkerSlots([]);
      });

    // load job-type-specific params
    fetchJobFormFields(config, jobType)
      .then((html) => {
        if (!cancelled) setParamsHtml(html);
      })
      .catch(() => {
        if (!cancelled) setParamsHtml('');
      });

    return () => {
      cancelled = true;
    };
  }, [visible, jobType, config]);

  async function onSubmit() {
    setError('');
    if (!config.pagePk) {
      setError('Page context missing — please reload and try again.');
      return;
    }
    const params = new URLSearchParams();
    params.set('job_type', jobType);
    params.set('document', config.documentPk || '');
    params.set('worker_slot', selectedWorker);
    params.set('page_pk', config.pagePk);
    params.set('force', 'on');
    if (paramsRef.current) {
      paramsRef.current.querySelectorAll('select, input').forEach((el) => {
        if (el.name) params.set(el.name, el.value);
      });
    }
    setSubmitting(true);
    try {
      const res = await createJob(config, params);
      if (!res.ok) {
        setError(res.error || 'Failed to start job');
        setSubmitting(false);
        return;
      }
      // Close modal via bootstrap before kicking off the poll.
      const Modal = window.bootstrap?.Modal;
      if (Modal && modalRef.current) Modal.getOrCreateInstance(modalRef.current).hide();
      onJobStarted?.(res.job_id || res.id, jobType);
    } catch {
      setError('Could not reach server');
      setSubmitting(false);
    }
  }

  const titles = { ocr: 'Run OCR on this page', ner: 'Run NER on this page' };
  const title = titles[jobType] || 'Run job on this page';
  const forceWarning =
    jobType === 'ocr' && confirmedWordCount > 0
      ? 'This will delete ' +
        confirmedWordCount +
        ' manually confirmed word' +
        (confirmedWordCount === 1 ? '' : 's')
      : '';

  return (
    <div
      className="modal fade"
      id="dpPageJobModal"
      tabIndex="-1"
      ref={modalRef}
      aria-labelledby="dpPageJobModalLabel"
      aria-hidden="true"
    >
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header py-2">
            <h5 className="modal-title h6" id="dpPageJobModalLabel">
              {title}
            </h5>
            <button
              type="button"
              className="btn-close"
              data-bs-dismiss="modal"
              aria-label="Close"
            />
          </div>
          <div className="modal-body">
            {error && <div id="dp-job-error" className="alert alert-danger py-2">{error}</div>}
            <div className="mb-3">
              <label className="form-label fw-semibold">Worker</label>
              <select
                id="dp-job-worker"
                className="form-select form-select-sm"
                value={selectedWorker}
                onChange={(e) => setSelectedWorker(e.target.value)}
              >
                {workerSlots.length === 0 && (
                  <option disabled value="">
                    Could not load workers
                  </option>
                )}
                {workerSlots.map((slot) => {
                  let stateLabel;
                  if (slot.job) stateLabel = 'running: ' + slot.job.job_type_label;
                  else if (slot.pending_count) stateLabel = slot.pending_count + ' pending';
                  else stateLabel = 'idle';
                  return (
                    <option key={slot.pk} value={slot.pk}>
                      {slot.name} ({stateLabel})
                    </option>
                  );
                })}
              </select>
            </div>
            <div
              id="dp-job-params"
              ref={paramsRef}
              dangerouslySetInnerHTML={{ __html: paramsHtml }}
            />
          </div>
          <div className="modal-footer py-2 flex-wrap gap-2">
            {forceWarning && (
              <div id="dp-job-force-warning" className="text-danger small w-100 mb-0">
                {forceWarning}
              </div>
            )}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              data-bs-dismiss="modal"
            >
              <i className="fa-solid fa-xmark me-1" />
              Cancel
            </button>
            <button
              type="button"
              id="dp-job-submit"
              className="btn btn-sm btn-primary"
              disabled={submitting}
              onClick={onSubmit}
            >
              <i className="fa-solid fa-play me-1" />
              Start job
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper hook: poll a job until complete/failed and reload on completion.
export function useJobPolling(config, activeJobs, onComplete) {
  useEffect(() => {
    const jobIds = Object.entries(activeJobs).filter(([, pk]) => pk);
    if (!jobIds.length) return;
    const timers = jobIds.map(([type, pk]) => {
      const id = setInterval(async () => {
        try {
          const data = await pollJob(config, pk);
          if (data.status === 'complete' || data.status === 'failed') {
            clearInterval(id);
            onComplete(type, data.status);
          }
        } catch {
          // ignore
        }
      }, 2000);
      return id;
    });
    return () => timers.forEach((id) => clearInterval(id));
  }, [config, activeJobs, onComplete]);
}
