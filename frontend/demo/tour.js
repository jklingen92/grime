// Step-through intro modal for the static demo. Takes named tours; each name
// is shown once per browser tab (sessionStorage), and unseen tours passed
// together play as one modal. Copy lives in tour-text.js. Needs Bootstrap's
// JS bundle (window.bootstrap) on the page.
//
//   import text from './tour-text.js';
//   showTour({ viewer: text.viewer, 'page:34': text.pages[34] });

const SEEN_KEY = 'grime-demo-tours-seen';
// Fallback when sessionStorage is blocked: tours then repeat on each page load.
const seenInMemory = new Set();

function readSeen() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY)) || []);
  } catch {
    return seenInMemory;
  }
}

function markSeen(names) {
  const seen = readSeen();
  names.forEach((n) => seen.add(n));
  names.forEach((n) => seenInMemory.add(n));
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* remembered for this page load only */
  }
}

export function showTour(tours) {
  const seen = readSeen();
  const names = Object.keys(tours).filter((n) => tours[n]?.length && !seen.has(n));
  const steps = names.flatMap((n) => tours[n]);
  if (!steps.length || !window.bootstrap) return;
  // Marked on show, not close: leaving mid-tour still counts as seen.
  markSeen(names);

  // Markup is built here rather than in index.html/viewer.html so both pages share it.
  const el = document.createElement('div');
  el.className = 'modal fade';
  el.tabIndex = -1;
  el.setAttribute('aria-labelledby', 'demo-tour-title');
  el.innerHTML = `
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h2 class="modal-title h5" id="demo-tour-title"></h2>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-footer">
          <span class="text-muted small me-auto" data-tour="count"></span>
          <button type="button" class="btn btn-outline-secondary btn-sm" data-tour="back">Back</button>
          <button type="button" class="btn btn-grime btn-sm" data-tour="next"></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);

  const title = el.querySelector('.modal-title');
  const body = el.querySelector('.modal-body');
  const count = el.querySelector('[data-tour="count"]');
  const back = el.querySelector('[data-tour="back"]');
  const next = el.querySelector('[data-tour="next"]');
  const modal = new window.bootstrap.Modal(el);
  let i = 0;

  function render() {
    title.textContent = steps[i].title;
    body.innerHTML = steps[i].body;
    count.textContent = steps.length > 1 ? `${i + 1} of ${steps.length}` : '';
    back.hidden = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
  }

  back.addEventListener('click', () => {
    i -= 1;
    render();
  });
  next.addEventListener('click', () => {
    if (i === steps.length - 1) return modal.hide();
    i += 1;
    render();
  });

  // Keep keys from reaching the viewer's document-level shortcuts (e.g. A
  // toggles draw mode). Bootstrap's Esc handler sits on this element, so it still runs.
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('hidden.bs.modal', () => {
    modal.dispose();
    el.remove();
  });

  render();
  modal.show();
}
