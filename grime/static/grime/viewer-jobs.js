export function createJobsModule(core) {
  var C = core.C;

  var _pollTimers = {};
  var _activeJobs = {};

  /* ── fetch live worker slots and populate select ────────────── */
  async function _populateWorkerSelect() {
    var sel = document.getElementById('dp-job-worker');
    if (!sel || !C.jobStatusUrl) return;

    sel.innerHTML = '<option disabled value="">Loading workers…</option>';

    try {
      var res = await fetch(C.jobStatusUrl);
      if (!res.ok) throw new Error('status ' + res.status);
      var data = await res.json();
      var slots = data.slots || [];

      sel.innerHTML = '';
      var firstIdleOpt = null;

      slots.forEach(function(slot) {
        var opt = document.createElement('option');
        opt.value = slot.pk;

        var stateLabel;
        if (slot.job) {
          stateLabel = 'running: ' + slot.job.job_type_label;
        } else if (slot.pending_count) {
          stateLabel = slot.pending_count + ' pending';
        } else {
          stateLabel = 'idle';
          if (!firstIdleOpt) firstIdleOpt = opt;
        }

        opt.textContent = slot.name + ' (' + stateLabel + ')';
        sel.appendChild(opt);
      });

      // Default to the lowest-indexed idle worker; fall back to first slot
      if (firstIdleOpt) {
        firstIdleOpt.selected = true;
      } else if (sel.options.length) {
        sel.options[0].selected = true;
      }
    } catch (err) {
      sel.innerHTML = '<option disabled value="">Could not load workers</option>';
    }
  }

  /* ── load job-specific param fields via AJAX ────────────────── */
  async function _loadJobParams(jobType) {
    var container = document.getElementById('dp-job-params');
    if (!container || !C.jobFormFieldsUrl) return;
    container.innerHTML = '';
    try {
      var res = await fetch(C.jobFormFieldsUrl + '?type=' + encodeURIComponent(jobType));
      container.innerHTML = res.ok ? await res.text() : '';
    } catch { container.innerHTML = ''; }
  }

  /* ── configure modal content before Bootstrap shows it ──────── */
  function _configureModal(jobType) {
    (document.getElementById('dp-job-type')     || {}).value = jobType;
    (document.getElementById('dp-job-document') || {}).value = C.documentPk || '';
    (document.getElementById('dp-job-page')     || {}).value = C.pagePk || '';

    var forceEl = document.getElementById('dp-job-force');
    var warnEl  = document.getElementById('dp-job-force-warning');

    if (jobType === 'ocr') {
      if (forceEl) forceEl.checked = true;
      if (warnEl) {
        var n = C.confirmedWordCount || 0;
        if (n > 0) {
          warnEl.textContent = 'This will delete ' + n + ' manually confirmed word' + (n === 1 ? '' : 's');
          warnEl.classList.remove('d-none');
        } else {
          warnEl.classList.add('d-none');
        }
      }
    } else {
      if (forceEl) forceEl.checked = false;
      if (warnEl) warnEl.classList.add('d-none');
    }

    var titleEl = document.getElementById('dpPageJobModalLabel');
    if (titleEl) {
      var labels = { ocr: 'Run OCR on this page', ner: 'Run NER on this page' };
      titleEl.textContent = labels[jobType] || 'Run job on this page';
    }

    var errEl = document.getElementById('dp-job-error');
    if (errEl) errEl.classList.add('d-none');

    var submitBtn = document.getElementById('dp-job-submit');
    if (submitBtn) submitBtn.disabled = false;

    // Both fetches are fire-and-forget; each updates the DOM on completion
    _populateWorkerSelect();
    _loadJobParams(jobType);
  }

  /* ── spinner helpers ────────────────────────────────────────── */
  function _showSpinner(jobType) {
    var btn = document.getElementById('dp-rerun-' + jobType);
    var spinner = document.getElementById('dp-rerun-' + jobType + '-spinner');
    if (btn) btn.style.display = 'none';
    if (spinner) spinner.style.display = '';
  }

  function _hideSpinner(jobType) {
    var btn = document.getElementById('dp-rerun-' + jobType);
    var spinner = document.getElementById('dp-rerun-' + jobType + '-spinner');
    if (btn) btn.style.display = '';
    if (spinner) spinner.style.display = 'none';
  }

  /* ── poll until complete ────────────────────────────────────── */
  function _startPolling(jobPk, jobType) {
    _activeJobs[jobType] = jobPk;
    _pollTimers[jobType] = setInterval(async function() {
      if (!_activeJobs[jobType]) { clearInterval(_pollTimers[jobType]); return; }
      try {
        var url = C.jobPollUrlTpl.replace('{pk}', jobPk);
        var res = await fetch(url);
        if (!res.ok) return;
        var data = await res.json();
        if (data.status === 'complete' || data.status === 'failed') {
          clearInterval(_pollTimers[jobType]);
          delete _activeJobs[jobType];
          _hideSpinner(jobType);
          if (data.status === 'complete') window.location.reload();
        }
      } catch {}
    }, 2000);
  }

  /* ── setup ──────────────────────────────────────────────────── */
  function setupUI() {
    var modalEl = document.getElementById('dpPageJobModal');
    if (modalEl) {
      modalEl.addEventListener('show.bs.modal', function(event) {
        var trigger = event.relatedTarget;
        var jobType = trigger ? trigger.dataset.dpJobType : '';
        if (jobType) _configureModal(jobType);
      });
    }

    var submitBtn = document.getElementById('dp-job-submit');
    if (!submitBtn) return;

    submitBtn.addEventListener('click', async function() {
      var jobType  = (document.getElementById('dp-job-type')     || {}).value || '';
      var docPk    = (document.getElementById('dp-job-document') || {}).value || '';
      var pagePk   = (document.getElementById('dp-job-page')     || {}).value || '';
      var workerPk = (document.getElementById('dp-job-worker')   || {}).value || '';
      var force    = !!(document.getElementById('dp-job-force')  || {}).checked;
      var errEl    = document.getElementById('dp-job-error');

      if (errEl) errEl.classList.add('d-none');

      // Guard: page_pk must be present — without it the job would process
      // every page in the document instead of just the current one.
      if (!pagePk) {
        if (errEl) { errEl.textContent = 'Page context missing — please reload and try again.'; errEl.classList.remove('d-none'); }
        return;
      }

      var params = new URLSearchParams();
      params.set('job_type', jobType);
      params.set('document', docPk);
      params.set('worker_slot', workerPk);
      params.set('page_pk', pagePk);
      if (force) params.set('force', 'on');

      // Collect type-specific params (engine, model, etc.)
      document.querySelectorAll('#dp-job-params select, #dp-job-params input').forEach(function(el) {
        if (el.name) params.set(el.name, el.value);
      });

      submitBtn.disabled = true;
      try {
        var res = await fetch(C.jobCreateUrl, {
          method: 'POST',
          headers: { 'X-CSRFToken': C.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        var json = await res.json();
        if (res.ok) {
          // Dismiss using Bootstrap's own handler — works even if Bootstrap was loaded
          // more than once in the page (admin embed + standalone base template).
          var dismissBtn = modalEl.querySelector('[data-bs-dismiss="modal"]');
          if (dismissBtn) {
            dismissBtn.click();
          } else {
            // Fallback: manual cleanup
            modalEl.classList.remove('show');
            modalEl.style.display = 'none';
            modalEl.setAttribute('aria-hidden', 'true');
            modalEl.removeAttribute('aria-modal');
            document.querySelectorAll('.modal-backdrop').forEach(function(el) { el.remove(); });
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('overflow');
            document.body.style.removeProperty('padding-right');
          }
          _showSpinner(jobType);
          _startPolling(json.job_id, jobType);
        } else {
          if (errEl) { errEl.textContent = json.error || 'Failed to start job'; errEl.classList.remove('d-none'); }
          submitBtn.disabled = false;
        }
      } catch {
        if (errEl) { errEl.textContent = 'Could not reach server'; errEl.classList.remove('d-none'); }
        submitBtn.disabled = false;
      }
    });
  }

  return { setupUI };
}
