# viewer.js → ES Module Refactor Plan

## Branch
`claude/refactor-viewer-js-748AX`

## Context
`grime/static/grime/viewer.js` is a ~1900-line IIFE handling all viewer
interactivity (OCR, NER, label/tag tabs). This plan splits it into ES modules
without a build step. The Django template loads the entry point as
`<script type="module">`.

The template is `grime/templates/admin/grime/_document_viewer.html`.
It calls three window globals inline via `onclick`:
- `dpShowTab('ocr'|'ner'|'label')`
- `dpZoomIn()`, `dpZoomOut()`, `dpZoomReset()`

These must remain on `window` after the refactor (or the template must be updated
to remove inline handlers — see step 6).

---

## Target file structure

```
grime/static/grime/
  viewer.js          ← entry point (replaces the IIFE)
  viewer-core.js     ← state, utilities, zoom, tabs, renderOverlays dispatcher
  viewer-ocr.js      ← all OCR logic
  viewer-ner.js      ← all NER logic
  viewer-tag.js      ← all label/tag logic
```

---

## Shared utilities to create (do these first, inside viewer.js, before splitting)

These exist in no form today — extract them during the refactor:

### `postJson(url, body)`
```js
function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN },
    body: body
  }).then(function(r) { return r.json(); });
}
```
Replaces 15+ identical fetch blocks throughout the file.

### `positionAtViewerEdge(el)`
```js
function positionAtViewerEdge(el) {
  var rect = document.getElementById('dp-viewer-wrap').getBoundingClientRect();
  el.style.left = (rect.right - 8) + 'px';
  el.style.top  = (rect.top  + 8) + 'px';
  el.style.display = 'block';
}
```
Used by: OCR edit popup, NER popup, NER select bar, OCR merge bar.

### `updateSelectBar(barId, labelId, n)`
```js
function updateSelectBar(barId, labelId, n) {
  var bar = document.getElementById(barId);
  if (!bar) return;
  if (n < 2) { bar.style.display = 'none'; return; }
  var lbl = document.getElementById(labelId);
  if (lbl) lbl.textContent = n + ' word' + (n === 1 ? '' : 's') + ' selected';
  positionAtViewerEdge(bar);
}
```
Replaces `updateOcrMergeBar` and `updateNerSelectBar` (near-identical today).
Note: `updateNerSelectBar` also pre-fills a dropdown — keep that logic in the NER
module, calling `updateSelectBar` for the shared positioning/count part.

### `applyOcrWordDiff(data)`
```js
function applyOcrWordDiff(data) {
  var del = new Set(data.deleted_ids);
  OCR_WORDS = OCR_WORDS.filter(function(w) { return !del.has(w.id); });
  data.deleted_ids.forEach(function(id) { delete wordById[id]; });
  (data.new_words || []).forEach(function(w) { OCR_WORDS.push(w); wordById[w.id] = w; });
}
```
Used identically in `runOcr` and `rerunSelectionOcr`. After extracting,
`rerunSelectionOcr` can be merged into `runOcr` (they differ only in which button
they update and whether they pass `word_pks`).

### `withBtn(btn, busyLabel, fn)`
```js
function withBtn(btn, busyLabel, fn) {
  if (!btn) return fn();
  var prev = btn.textContent;
  btn.disabled = true; btn.textContent = busyLabel;
  return fn().finally(function() { btn.disabled = false; btn.textContent = prev; });
}
```
Used by: `runOcr`, `runNer`, `confirmAll`, recluster, resolveDittos, clearWords.
Requires `fn()` to return a Promise. Each call site needs to be updated to return
the fetch chain.

### `updateRubberBand(rectEl, startX, startY, curX, curY, viewerRect)`
```js
function updateRubberBand(rectEl, x0, y0, x1, y1, vr) {
  rectEl.style.left   = Math.min(x0, x1) - vr.left + 'px';
  rectEl.style.top    = Math.min(y0, y1) - vr.top  + 'px';
  rectEl.style.width  = Math.abs(x1 - x0) + 'px';
  rectEl.style.height = Math.abs(y1 - y0) + 'px';
  rectEl.style.display = 'block';
}
```
Duplicated in OCR mousemove, NER mousemove, tag-draw mousemove, tag-sub mousemove.

---

## Module interface

Each feature module exports a factory `createXxxModule(core)` returning:

```js
{
  render(viewer, scale),      // draws overlays for this tab
  onMousedown(e),
  onMousemove(e),
  onMouseup(e),
  setupUI(),                  // binds all DOM event listeners for this tab
  clearSelection(),           // called by dpShowTab when leaving this tab
  activate(),                 // called by dpShowTab when entering this tab
}
```

`core` is the object returned by `initCore(config)` (see viewer-core.js below).

---

## viewer-core.js

**Exports:** `initCore(config)`

**Responsibility:** everything that isn't specific to one tab.

```js
// viewer-core.js
export function initCore(C) {
  // --- constants (from C) ---
  var CSRF_TOKEN = C.csrfToken;
  var PREV_URL = C.prevUrl;  // etc.

  // --- mutable shared data ---
  var OCR_WORDS = C.ocrWords;
  var TAGS = C.tags;
  var wordById = {};
  OCR_WORDS.forEach(function(w) { if (w.id != null) wordById[w.id] = w; });

  // --- state ---
  var state = { activeTab: ..., zoomLevel: 1.0, ... /* full state object */ };

  // --- utilities ---
  function postJson(url, body) { ... }
  function positionAtViewerEdge(el) { ... }
  function updateSelectBar(barId, labelId, n) { ... }
  function applyOcrWordDiff(data) { /* mutates OCR_WORDS, wordById via core */ }
  function withBtn(btn, busyLabel, fn) { ... }
  function updateRubberBand(rectEl, x0, y0, x1, y1, vr) { ... }
  function getRefWidth() { ... }
  function getScale() { ... }
  function navigate(url) { ... }
  function viewerOffset(e) { ... }

  // --- zoom ---
  function applyZoom() { ... }
  function dpFit() { ... }
  function dpZoomIn() { ... }
  function dpZoomOut() { ... }
  function dpZoomReset() { ... }

  // --- tab management ---
  var _modules = {};  // registered feature modules
  function registerModule(name, mod) { _modules[name] = mod; }

  function renderOverlays() {
    var viewer = document.getElementById('dp-viewer');
    var img    = document.getElementById('dp-img');
    if (!viewer || !img || !img.naturalWidth) return;
    viewer.querySelectorAll('.dp-word-ghost, .ocr-word, .dp-tag-overlay, .dp-ner-overlay')
      .forEach(function(el) { el.remove(); });
    var mod = _modules[state.activeTab];
    if (mod) mod.render(viewer, getScale());
  }

  function dpShowTab(name) {
    var leaving = _modules[state.activeTab];
    if (leaving && leaving.clearSelection) leaving.clearSelection();
    if (leaving && leaving.deactivate)     leaving.deactivate();
    state.activeTab = name;
    // toggle tab button classes, show/hide panels...
    var entering = _modules[name];
    if (entering && entering.activate) entering.activate();
    renderOverlays();
    updateBadge();
  }

  function updateBadge() { ... }  // reads OCR_WORDS, TAGS from core

  // --- divider resize ---
  // ... (stable, keep in core)

  // --- page-jump select ---
  // ... (stable, keep in core)

  // --- mouse dispatcher ---
  // Delegates to the active module's onMousedown/move/up.
  function onViewerMousedown(e) {
    var mod = _modules[state.activeTab];
    if (mod && mod.onMousedown) mod.onMousedown(e);
  }
  function onDocMousemove(e) {
    // Divider drag is handled here (not tab-specific).
    // Then delegate:
    var mod = _modules[state.activeTab];
    if (mod && mod.onMousemove) mod.onMousemove(e);
  }
  function onDocMouseup(e) {
    var mod = _modules[state.activeTab];
    if (mod && mod.onMouseup) mod.onMouseup(e);
  }

  // --- keyboard dispatcher ---
  document.addEventListener('keydown', function(e) {
    // Arrow keys / undo / redo handled here.
    // Tab-specific keys delegated:
    var mod = _modules[state.activeTab];
    if (mod && mod.onKeydown) mod.onKeydown(e);
  });

  // --- coordinate readout, wheel zoom ---
  // ... (stable, keep in core)

  // --- expose window globals the template needs ---
  window.dpShowTab   = dpShowTab;
  window.dpZoomIn    = dpZoomIn;
  window.dpZoomOut   = dpZoomOut;
  window.dpZoomReset = dpZoomReset;
  window._viewerState = state;

  return {
    // data (modules read/write these)
    state, C,
    get OCR_WORDS() { return OCR_WORDS; },
    set OCR_WORDS(v) { OCR_WORDS = v; },
    get TAGS() { return TAGS; },
    set TAGS(v) { TAGS = v; },
    wordById,

    // utilities
    postJson, positionAtViewerEdge, updateSelectBar, applyOcrWordDiff,
    withBtn, updateRubberBand, getScale, getRefWidth, viewerOffset, navigate,

    // rendering
    renderOverlays, dpShowTab, updateBadge,

    // registration
    registerModule,

    // mouse binding (called from entry point after modules registered)
    bindMouseHandlers: function() {
      document.getElementById('dp-viewer').addEventListener('mousedown', onViewerMousedown);
      document.addEventListener('mousemove', onDocMousemove);
      document.addEventListener('mouseup',   onDocMouseup);
    },
  };
}
```

**Note on mutable arrays:** `OCR_WORDS` and `TAGS` are reassigned (not just mutated)
in several places. Exposing them as getter/setter on the core object means modules
do `core.OCR_WORDS = filtered` rather than direct reassignment. Every current
`OCR_WORDS = ...` reference must be updated to `core.OCR_WORDS = ...` in the
respective module.

---

## viewer-ocr.js

**Exports:** `createOcrModule(core)`

**Contains:**
- `clearSelection()` / `updateMergeBar()` — uses `core.updateSelectBar('ocr-merge-bar', 'ocr-merge-label', n)`
- `ocrSelectInRect(x1, y1, x2, y2, shiftKey)`
- `selectAllOcrWords()`
- `openEditPopup` / `closeEditPopup` / `postCorrection` / `saveEdit` / `confirmEdit`
- `deleteWord`, `_deleteWordById`, `_addWordFromData`, `saveAddRegion`
- `undo()` / `redo()` / `recordUndo()`
- `markWordAsDitto()` / `_applyDittoResult()` / `bulkDitto()`
- `bulkDelete()`
- `confirmAll()`
- `runOcr(engine)` — absorbs `rerunSelectionOcr` (merge them; pass `word_pks` only when `state.ocrSelectedIds.size > 0`)
- `setDrawMode(active)`
- `wordClass(w)`, `ocrBtnLabel()`
- `updateTextPanels()`, `syncTextPanelSelection()`, `buildFullText()`, `_buildLineMap()`
- `applyTextSearch(query)`, `onTextPanelMouseup(e)`
- `render(viewer, scale)` — the OCR branch of `renderOverlays`
- `onMousedown(e)`, `onMousemove(e)`, `onMouseup(e)` — OCR branches of the unified mouse handlers
- `onKeydown(e)` — OCR-specific keys (a=draw mode, delete=bulk delete, escape, ctrl+a)
- `setupUI()` — binds all OCR DOM listeners (popup buttons, toolbar buttons, merge bar, search, text panel)

---

## viewer-ner.js

**Exports:** `createNerModule(core)`

**Contains:**
- `nerEffectiveLabel(w)`, `nerEntityType(w)`
- `nerOpenPopup(wordId)` / `nerClosePopup()`
- `clearSelection()` / `updateSelectBar()` — calls `core.updateSelectBar('ner-select-bar', 'ner-select-label', n)`, then pre-fills the type dropdown (extra step beyond shared util)
- `nerSelectInRect(x1, y1, x2, y2, shiftKey)`
- `nerApplyBulkLabel(type)`
- `nerBuildEntities()` / `nerBuildEntityList()` / `nerHighlightWordIdSet()`
- `runNer()` / `nerBtnLabel()`
- `nerSuggestSubcomps(bbox)` — called by viewer-tag.js; export it so tag module can import it, or expose via core
- `render(viewer, scale)` — NER branch of `renderOverlays`
- `onMousedown(e)`, `onMousemove(e)`, `onMouseup(e)` — NER branches
- `onKeydown(e)` — Escape closes popup + clears selection
- `activate()` — calls `nerBuildEntityList()`
- `setupUI()` — NER popup buttons, section collapse headers, select bar buttons

**Note on `nerSuggestSubcomps`:** the tag module calls this when entering labeling
mode. Since viewer-tag.js imports viewer-ner.js would create a circular dependency,
expose it via `core`:

```js
// in viewer-ner.js createNerModule:
core.nerSuggestSubcomps = nerSuggestSubcomps;
```
Then viewer-tag.js calls `core.nerSuggestSubcomps(bbox)`.

---

## viewer-tag.js

**Exports:** `createTagModule(core)`

**Contains:**
- `tagBuildList()` / `tagRenderTagOverlays()`
- `tagOpenExisting(tag)`
- `tagEnterLabelingMode()` / `tagExitLabelingMode()`
- `tagUpdateVeils()`
- `tagUpdateSubcompDisplay()`
- `tagMaybeShowSubInput()`
- `tagConfirmSubLabel(label)`, `_commonSelectedLabel()`
- `tagSubWordClick(wordId, shiftKey)`, `tagSubSelectInRect(...)`
- `tagPopulateLabelDatalist()`
- `tagSave()` / `tagDelete()` / `adjustDocTagCount(delta)`
- `isDitto(text)` / `resolveDitto(label, currentTop)`
- `render(viewer, scale)` — label branch of `renderOverlays`
- `onMousedown(e)`, `onMousemove(e)`, `onMouseup(e)` — label branches (tag draw, sub-select, resize)
- `onKeydown(e)` — Enter/Escape/Delete in labeling mode
- `clearSelection()` — calls `tagExitLabelingMode()` if in labeling phase
- `setupUI()` — tag panel buttons (save, cancel, delete, sub-clear, sub-input Enter key, corner resize handles)

---

## viewer.js (entry point)

```js
// viewer.js
import { initCore }        from './viewer-core.js';
import { createOcrModule } from './viewer-ocr.js';
import { createNerModule } from './viewer-ner.js';
import { createTagModule } from './viewer-tag.js';

var core = initCore(window.VIEWER_CONFIG);

var ocr = createOcrModule(core);
var ner = createNerModule(core);
var tag = createTagModule(core);

core.registerModule('ocr',   ocr);
core.registerModule('ner',   ner);
core.registerModule('label', tag);

// UI setup (runs immediately — module is always deferred as type="module")
ocr.setupUI();
ner.setupUI();
tag.setupUI();
core.bindMouseHandlers();

// --- global click handler (cross-module concerns) ---
document.addEventListener('click', function(e) {
  if (core.state.suppressClickClose) { core.state.suppressClickClose = false; return; }
  ocr.onGlobalClick(e);
  ner.onGlobalClick(e);
  var ocrMenu = document.getElementById('dp-rerun-ocr-menu');
  if (ocrMenu && ocrMenu.classList.contains('open') && !e.target.closest('.dp-split-btn'))
    ocrMenu.classList.remove('open');
});

// --- init ---
core.initPageSelect();  // page-jump select, nav buttons
tag.buildList();
tag.renderTagOverlays();
tag.populateLabelDatalist();
core.dpShowTab(core.state.activeTab);

var img = document.getElementById('dp-img');
if (img) {
  var onLoad = function() { core.dpFit(); core.updateBadge(); ocr.updateTextPanels(); };
  if (img.complete) onLoad();
  else img.addEventListener('load', onLoad);
}
```

**Note:** `<script type="module">` is always deferred (equivalent to `defer`), so
there's no need for a DOMContentLoaded wrapper — the DOM is ready when the script
runs. Remove all `document.addEventListener('DOMContentLoaded', ...)` wrappers.

---

## Template change

In `grime/templates/admin/grime/_document_viewer.html`, line 265:

```html
<!-- before -->
<script src="{% static 'grime/viewer.js' %}"></script>

<!-- after -->
<script type="module" src="{% static 'grime/viewer.js' %}"></script>
```

No other template changes needed. The `onclick="dpShowTab(...)"` etc. continue
to work because core re-assigns them to `window`.

---

## Implementation order

Do each step, verify nothing is broken, then proceed.

1. **Utility extraction** — while still in the single IIFE, extract `postJson`,
   `positionAtViewerEdge`, `updateSelectBar`, `applyOcrWordDiff`, `withBtn`,
   `updateRubberBand`. Run in browser, confirm existing behaviour unchanged.

2. **Merge `rerunSelectionOcr` into `runOcr`** — straightforward deduplication.

3. **Unminify** `_deleteWordById`, `_addWordFromData`, `_applyHistory`,
   `confirmAll`, `ocrSelectInRect`, `setDrawMode`, `saveAddRegion`. No behaviour
   change.

4. **Create `viewer-core.js`** — move state, utilities, zoom, tabs,
   `renderOverlays` dispatcher, mouse dispatcher skeleton. Update template to
   `type="module"`. Keep viewer.js as the entry point importing from core.
   At this point the three tab modules don't exist yet, so the dispatchers are
   just stubs — tabs still work because the old IIFE logic is still in viewer.js.

5. **Extract `viewer-ocr.js`** — move all OCR functions. Wire into core via
   `registerModule`. Delete OCR code from viewer.js.

6. **Extract `viewer-ner.js`** — same. Wire `nerSuggestSubcomps` via
   `core.nerSuggestSubcomps`.

7. **Extract `viewer-tag.js`** — same.

8. **Clean up viewer.js** — should now be just the 40-line entry point above.

9. **Final pass** — remove any remaining dead code, confirm all three tabs and
   all keyboard shortcuts work end-to-end.

---

## Things to watch out for

- **`OCR_WORDS` / `TAGS` reassignment**: anywhere the code does `OCR_WORDS = ...`
  (filter after delete, replace after rerun) must become `core.OCR_WORDS = ...`.
  Search for all bare assignments before splitting.

- **`wordById` is an object**, not reassigned — direct property mutation is fine,
  but every module accesses it via `core.wordById`.

- **`suppresClickClose`** lives on `state` — both OCR and NER set it. Since
  `state` is on `core`, both modules access `core.state.suppressClickClose`.

- **`HAS_REPAIR` guards**: several OCR functions early-return if `!HAS_REPAIR`.
  Keep these guards in the OCR module; don't let them bleed into core.

- **`window._viewerState`** is set in core for debugging; preserve it.

- **ES module MIME type**: Django's `StaticFilesStorage` serves `.js` as
  `application/javascript`, which browsers accept for modules. No server config
  needed.
