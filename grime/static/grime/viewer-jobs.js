export function createJobsModule(core) {
  var C = core.C;

  var _pollTimers = {};
  var _activeJobs = {};

  /* ── worker slot select ─────────────────────────────────────── */
  function _populateWorkerSelect() {
    var sel = document.getElementById('dp-job-worker');
    if (!sel || !C.workerSlots) return;
    sel.innerHTML = '';
    C.workerSlots.forEach(function(slot) {
      var opt = document.createElement('option');
      opt.value = slot.pk;
      opt.textContent = slot.name;
      sel.appendChild(opt);
    });
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

  /* ── open modal ─────────────────────────────────────────────── */
  function openJobModal(jobType) {
    var typeInput = document.getElementById('dp-job-type');
    if (typeInput) typeInput.value = jobType;
    var docInput = document.getElementById('dp-job-document');
    if (docInput) docInput.value = C.documentPk;
    var pageInput = document.getElementById('dp-job-page');
    if (pageInput) pageInput.value = C.pagePk;
    var forceInput = document.getElementById('dp-job-force');
    if (forceInput) forceInput.checked = false;

    var titleEl = document.getElementById('dpPageJobModalLabel');
    if (titleEl) {
      var labels = { ocr: 'Run OCR on this page', ner: 'Run NER on this page' };
      titleEl.textContent = labels[jobType] || 'Run job on this page';
    }

    var errEl = document.getElementById('dp-job-error');
    if (errEl) errEl.classList.add('d-none');

    var submitBtn = document.getElementById('dp-job-submit');
    if (submitBtn) submitBtn.disabled = false;

    _populateWorkerSelect();
    _loadJobParams(jobType);

    var modalEl = document.getElementById('dpPageJobModal');
    if (modalEl) new bootstrap.Modal(modalEl).show();
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

  /* ── submit handler ─────────────────────────────────────────── */
  function setupUI() {
    var submitBtn = document.getElementById('dp-job-submit');
    if (!submitBtn) return;

    submitBtn.addEventListener('click', async function() {
      var jobType   = (document.getElementById('dp-job-type')     || {}).value || '';
      var docPk     = (document.getElementById('dp-job-document') || {}).value || '';
      var pagePk    = (document.getElementById('dp-job-page')     || {}).value || '';
      var workerPk  = (document.getElementById('dp-job-worker')   || {}).value || '';
      var force     = (document.getElementById('dp-job-force')    || {}).checked;
      var errEl     = document.getElementById('dp-job-error');

      if (errEl) errEl.classList.add('d-none');

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
          bootstrap.Modal.getInstance(document.getElementById('dpPageJobModal')).hide();
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

  return { openJobModal, setupUI };
}
