// Static-demo viewer entry (viewer.html?page=<pk>): builds window.VIEWER_CONFIG
// from the exported page (`python manage.py export_demo --page <pk>` ->
// demo-data/pages/<pk>/page.json), installs the fetch mock, then mounts the
// real viewer unchanged.
//
//   npm run build:demo   # -> dist-demo/, served from /grime/

import { DEMO_URLS, installMockServer } from './mockServer.js';
import { showTour } from './tour.js';
import tourText from './tour-text.js';

// Exported files live under pages/<pk>/, copied next to the HTML at the deploy base.
const pagePk = parseInt(new URLSearchParams(location.search).get('page'), 10);
const pageDir = `${import.meta.env.BASE_URL}pages/${pagePk}/`;
const res = Number.isNaN(pagePk) ? null : await fetch(pageDir + 'page.json');
if (!res?.ok) {
  // No such exported page: back to the dashboard.
  location.replace(import.meta.env.BASE_URL);
  throw new Error(`Demo page ${pagePk} not found`);
}
const page = await res.json();

const STORAGE_KEY = 'grime-demo:' + page.pagePk;

// localStorage can be missing or throw (private mode, blocked storage); the
// demo then just forgets edits on refresh.
function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function save(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* edits stay in memory only */
  }
}

const originalImageUrl = pageDir + page.originalImageUrl;

// The mock mutates its store, so it must not share objects with React state.
const store = loadSaved() || {
  words: structuredClone(page.ocrWords),
  annotations: structuredClone(page.annotations),
  imageAdjustments: page.imageAdjustments,
  imageHasCorrected: page.imageHasCorrected,
  nextId: -1,
};

window.VIEWER_CONFIG = {
  ...DEMO_URLS,
  citations: page.citations,
  ocrWords: structuredClone(store.words),
  annotations: structuredClone(store.annotations),
  hasRepair: true,
  prevUrl: null,
  nextUrl: null,
  pageList: null,
  currentPagePk: page.pagePk,
  pagePk: page.pagePk,
  annotationSourceTypeId: 0,
  annotationSourceId: page.pagePk,
  csrfToken: '',
  usePreprocessedBbox: false,
  // Adjustments are re-applied as a live CSS preview over the original, since
  // the demo never bakes a corrected image.
  imageUrl: originalImageUrl,
  originalImageUrl,
  imageHasCorrected: false,
  imageAdjustments: store.imageAdjustments,
  imageAlt: page.imageAlt,
  docAnnotationCount: page.docAnnotationCount,
  confirmedWordCount: page.confirmedWordCount,
  nerModels: page.nerModels,
  navPrefix: '',
  navPrevLabel: 'Previous',
  navNextLabel: 'Next',
  // 'label' and 'imageSave' are hidden; the rest are grayed out.
  demoDisabled: ['jobs', 'exportPdf', 'autocontrast', 'imageSave', 'label'],
};

document.getElementById('demo-title').textContent = page.documentTitle;
document.title = `${page.documentTitle} · Grime demo`;
document.getElementById('demo-reset').addEventListener('click', () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing saved */
  }
  location.reload();
});

installMockServer(store, { originalImageUrl, onChange: save });

// Dynamic import so the viewer reads VIEWER_CONFIG only after it's set.
await import('../src/viewer-page.jsx');

// General viewer intro, then this page's own cards (keyed by page pk).
showTour({ viewer: tourText.viewer, ['page:' + page.pagePk]: tourText.pages[page.pagePk] });

// Per-tab cards on first open. TabBar buttons are id="tab-<key>"; listening
// here keeps the demo copy out of the real viewer code.
document.addEventListener('click', (e) => {
  const key = e.target.closest('.dp-tab')?.id.replace(/^tab-/, '');
  if (key) showTour({ ['tab:' + key]: tourText.tabs[key] });
});
