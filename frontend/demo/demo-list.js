// Static-demo dashboard: fills the documents table from manifest.json
// (`python manage.py export_demo --page A --page B` -> demo-data/). Rows mirror
// grime/templates/grime/document_list.html; titles open viewer.html?page=<pk>.

import { showTour } from './tour.js';
import tourText from './tour-text.js';

const DISABLED_TITLE = 'Not available in the demo';

// Escape manifest text before it goes into innerHTML.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Server-backed buttons stay visible but disabled, like DemoDisabled in the viewer.
// The wrapper span carries the tooltip since disabled buttons get no pointer events.
const disabledButton = (cls, inner) =>
  `<span class="d-inline-block" title="${DISABLED_TITLE}" tabindex="0">` +
  `<button type="button" class="btn btn-sm ${cls}" disabled aria-disabled="true">${inner}</button></span>`;

function row(doc) {
  const tags = doc.tags.length
    ? `<div class="d-flex flex-wrap gap-1">${doc.tags
        .map((t) => `<span class="badge" style="background-color:var(--grime-primary)">${esc(t)}</span>`)
        .join('')}</div>`
    : '<span class="text-muted">—</span>';
  const pages = doc.pageCount || '<span class="text-muted">—</span>';
  return `<tr>
    <td><a href="viewer.html?page=${doc.pagePk}"><i class="fa-regular fa-file-pdf me-1"></i>${esc(doc.title)}</a></td>
    <td>${tags}</td>
    <td>${pages}</td>
    <td class="text-center">${disabledButton('btn-outline-secondary', `<i class="fa-solid fa-tags me-1"></i>${doc.entityCount} entities`)}</td>
    <td><div class="d-flex gap-2 justify-content-end">
      ${disabledButton('btn-outline-secondary', 'Download PDF')}
      ${disabledButton('btn-outline-primary', '<i class="fa-solid fa-pencil"></i>')}
      ${disabledButton('btn-outline-danger', '<i class="fa-solid fa-trash"></i>')}
    </div></td>
  </tr>`;
}

const res = await fetch(import.meta.env.BASE_URL + 'manifest.json');
const docs = res.ok ? await res.json() : [];
document.getElementById('demo-doc-count').textContent = docs.length;
document.getElementById('demo-doc-rows').innerHTML = docs.map(row).join('');

showTour({ dashboard: tourText.dashboard });
