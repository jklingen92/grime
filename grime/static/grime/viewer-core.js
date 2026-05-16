export function initCore(C) {
  var OCR_WORDS = C.ocrWords;
  var TAGS      = C.tags;
  var wordById  = {};
  OCR_WORDS.forEach(function(w) { if (w.id != null) wordById[w.id] = w; });

  var state = {
    activeTab: (function() {
      var t = new URLSearchParams(window.location.search).get('tab');
      if (t === 'tagging') t = 'label';
      return (t === 'ocr' || t === 'ner' || t === 'label') ? t : 'ocr';
    })(),
    zoomLevel:          1.0,
    tagPhase:           'draw',
    tagDrawStart:       null,
    tagPendingBbox:     null,
    tagEditingId:       null,
    tagPendingLabel:    '',
    tagPendingSubcomps: [],
    tagSubSelectedIds:  new Set(),
    tagSubDrawStart:    null,
    tagResizing:        null,
    nerPopupWordId:     null,
    nerSelectedIds:     new Set(),
    nerHighlightKey:    null,
    personGroupsLoaded: false,
    ocrEngine:          'textract',
    ocrSelectedIds:     new Set(),
    currentWord:        null,
    currentEl:          null,
    selectStart:        null,
    isDragging:         false,
    suppressClickClose: false,
    undoStack:          [],
    redoStack:          [],
    boxesHidden:        false,
    drawMode:           false,
    drawOrigin:         null,
    sidePanelWidth:     260,
  };
  window._viewerState = state;

  /* ── utilities ─────────────────────────────────────────────── */
  // POST form-encoded body and parse JSON response, injecting CSRF token.
  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': C.csrfToken },
      body: body
    }).then(function(r) { return r.json(); });
  }

  // Show el flush with the right edge of the viewer wrap.
  function positionAtViewerEdge(el) {
    var rect = document.getElementById('dp-viewer-wrap').getBoundingClientRect();
    el.style.left = (rect.right - 8) + 'px';
    el.style.top  = (rect.top  + 8) + 'px';
    el.style.display = 'block';
  }

  // Show or hide a floating selection bar depending on how many words are selected.
  function updateSelectBar(barId, labelId, n) {
    var bar = document.getElementById(barId);
    if (!bar) return;
    if (n < 2) { bar.style.display = 'none'; return; }
    var lbl = document.getElementById(labelId);
    if (lbl) lbl.textContent = n + ' word' + (n === 1 ? '' : 's') + ' selected';
    positionAtViewerEdge(bar);
    bar.style.display = 'flex';
  }

  // Apply a server diff (deleted_ids / new_words) to OCR_WORDS and wordById in place.
  function applyOcrWordDiff(data) {
    var del = new Set(data.deleted_ids);
    OCR_WORDS = OCR_WORDS.filter(function(w) { return !del.has(w.id); });
    data.deleted_ids.forEach(function(id) { delete wordById[id]; });
    (data.new_words || []).forEach(function(w) { OCR_WORDS.push(w); wordById[w.id] = w; });
  }

  // Run fn() with btn disabled and showing busyLabel, then restore btn regardless of outcome.
  function withBtn(btn, busyLabel, fn) {
    if (!btn) return fn();
    var prev = btn.textContent;
    btn.disabled = true; btn.textContent = busyLabel;
    return fn().finally(function() { btn.disabled = false; btn.textContent = prev; });
  }

  // Position and show a rubber-band rect element between two client points.
  function updateRubberBand(rectEl, x0, y0, x1, y1, vr) {
    rectEl.style.left   = Math.min(x0, x1) - vr.left + 'px';
    rectEl.style.top    = Math.min(y0, y1) - vr.top  + 'px';
    rectEl.style.width  = Math.abs(x1 - x0) + 'px';
    rectEl.style.height = Math.abs(y1 - y0) + 'px';
    rectEl.style.display = 'block';
  }

  // Navigate to url, preserving the active tab in the query string.
  function navigate(url) {
    if (!url) return;
    window.location.href = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tab=' + state.activeTab;
  }

  // Return the reference pixel width used to map bbox coordinates to screen pixels.
  function getRefWidth() {
    var img = document.getElementById('dp-img');
    if (!img || !img.naturalWidth) return 1;
    return C.usePreprocessedBbox ? Math.max(img.naturalWidth, 2000) : img.naturalWidth;
  }

  // Return the current ratio of rendered image width to reference width.
  function getScale() {
    var img = document.getElementById('dp-img');
    return img ? img.clientWidth / getRefWidth() : 1;
  }

  // Return mouse position in viewer-local coordinates (unscaled pixels).
  function viewerOffset(e) {
    var r = document.getElementById('dp-viewer').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ── zoom ──────────────────────────────────────────────────── */
  // Apply state.zoomLevel to the image, re-render overlays and update the label.
  function applyZoom() {
    var img = document.getElementById('dp-img');
    if (!img) return;
    img.style.width = Math.round(img.naturalWidth * state.zoomLevel) + 'px';
    renderOverlays();
    if (state.tagPhase === 'labeling' && state.tagPendingBbox) {
      var tagMod = _modules['label'];
      if (tagMod && tagMod.updateVeils) tagMod.updateVeils();
    }
    document.getElementById('dp-zoom-label').textContent = Math.round(state.zoomLevel * 100) + '%';
  }

  // Fit the image to the available viewport area.
  function dpFit() {
    var img = document.getElementById('dp-img'), wrap = document.getElementById('dp-viewer-wrap');
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    var aw = wrap.parentElement.clientWidth - 4, ah = Math.round(window.innerHeight * 0.8) - 4;
    state.zoomLevel = Math.min(1.0, (aw / img.naturalWidth + ah / img.naturalHeight) / 2);
    applyZoom();
  }

  function dpZoomIn()    { state.zoomLevel = Math.min(state.zoomLevel + 0.25, 4.0);  applyZoom(); }
  function dpZoomOut()   { state.zoomLevel = Math.max(state.zoomLevel - 0.25, 0.25); applyZoom(); }
  function dpZoomReset() { dpFit(); }
  window.dpZoomIn = dpZoomIn; window.dpZoomOut = dpZoomOut; window.dpZoomReset = dpZoomReset;

  /* ── module registry ───────────────────────────────────────── */
  var _modules = {};
  // Register a tab module under name so the dispatcher can call its render/mouse/key hooks.
  function registerModule(name, mod) { _modules[name] = mod; }

  /* ── render dispatcher ─────────────────────────────────────── */
  // Clear all overlay elements and re-render the active tab's overlays.
  function renderOverlays() {
    var viewer = document.getElementById('dp-viewer'), img = document.getElementById('dp-img');
    if (!viewer || !img || !img.naturalWidth) return;
    viewer.querySelectorAll('.dp-word-ghost, .ocr-word, .dp-tag-overlay, .dp-ner-overlay')
      .forEach(function(el) { el.remove(); });
    var scale = getScale();
    var mod = _modules[state.activeTab];
    if (mod) mod.render(viewer, scale);
  }

  /* ── tab management ────────────────────────────────────────── */
  // Switch to named tab: clear outgoing selection, show/hide panels, activate incoming module.
  function dpShowTab(name) {
    var leaving = _modules[state.activeTab];
    if (leaving && leaving.clearSelection) leaving.clearSelection();
    state.activeTab = name;
    ['ocr', 'ner', 'label'].forEach(function(n) {
      var t = document.getElementById('tab-' + n);
      if (t) t.classList.toggle('active', name === n);
    });
    var actions = document.getElementById('dp-ocr-actions');
    var sep     = document.getElementById('dp-sep-ocr');
    var nerSep  = document.getElementById('dp-sep-ner');
    var nerBtn  = document.getElementById('dp-rerun-ner');
    var tagP    = document.getElementById('dp-tag-panel');
    var nerP    = document.getElementById('dp-ner-panel');
    var txtP    = document.getElementById('dp-text-panel');
    if (actions) { actions.classList.toggle('visible', name === 'ocr'); if (sep) sep.style.display = (name === 'ocr') ? '' : 'none'; }
    if (nerSep) nerSep.style.display = (name === 'ner') ? '' : 'none';
    if (nerBtn) nerBtn.style.display = (name === 'ner') ? '' : 'none';
    if (txtP)   txtP.classList.toggle('visible', name === 'ocr');
    if (nerP)   nerP.classList.toggle('visible', name === 'ner');
    if (tagP)   tagP.classList.toggle('visible', name === 'label');
    var entering = _modules[name];
    if (entering && entering.activate) entering.activate();
    renderOverlays();
    updateBadge();
  }
  window.dpShowTab = dpShowTab;

  // Update the tab badge with word/entity/label count for the active tab.
  function updateBadge() {
    var el = document.getElementById('dp-tab-badge');
    if (!el) return;
    if (state.activeTab === 'label') {
      el.textContent = TAGS.length ? TAGS.length + ' label' + (TAGS.length === 1 ? '' : 's') : 'No labels';
    } else if (state.activeTab === 'ner') {
      var n = OCR_WORDS.filter(function(w) {
        var lbl = w.corrected_label || w.ner_label;
        return lbl && lbl.replace(/^[BI]-/, '');
      }).length;
      el.textContent = n ? n + ' entity word' + (n === 1 ? '' : 's') : 'No NER data';
    } else {
      el.textContent = OCR_WORDS.length ? OCR_WORDS.length + ' word' + (OCR_WORDS.length === 1 ? '' : 's') : 'No OCR data';
    }
  }

  /* ── side-panel divider ────────────────────────────────────── */
  // Apply state.sidePanelWidth to all three side panels.
  function applySidePanelWidth() {
    ['dp-text-panel', 'dp-ner-panel', 'dp-tag-panel'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.width = state.sidePanelWidth + 'px';
    });
  }
  applySidePanelWidth();
  window._viewerApplySidePanelWidth = applySidePanelWidth;

  var dividerDrag = null;
  var divider = document.getElementById('dp-divider');
  if (divider) {
    divider.addEventListener('mousedown', function(e) {
      var panelId = state.activeTab === 'label' ? 'dp-tag-panel'
                  : state.activeTab === 'ner'   ? 'dp-ner-panel'
                  : 'dp-text-panel';
      var panel = document.getElementById(panelId);
      if (!panel) return;
      e.preventDefault();
      dividerDrag = { startX: e.clientX, startWidth: panel.offsetWidth };
    });
  }

  /* ── mouse dispatcher ──────────────────────────────────────── */
  // Forward viewer mousedown to the active tab module.
  function onViewerMousedown(e) {
    var mod = _modules[state.activeTab];
    if (mod && mod.onMousedown) mod.onMousedown(e);
  }

  // Forward document mousemove to divider drag or the active tab module.
  function onDocMousemove(e) {
    if (dividerDrag) {
      state.sidePanelWidth = Math.max(120, dividerDrag.startWidth - (e.clientX - dividerDrag.startX));
      applySidePanelWidth();
      return;
    }
    var mod = _modules[state.activeTab];
    if (mod && mod.onMousemove) mod.onMousemove(e);
  }

  // Forward document mouseup to divider drag end or the active tab module.
  function onDocMouseup(e) {
    if (dividerDrag) { dividerDrag = null; return; }
    var mod = _modules[state.activeTab];
    if (mod && mod.onMouseup) mod.onMouseup(e);
  }

  // Attach viewer and document mouse event listeners.
  function bindMouseHandlers() {
    document.getElementById('dp-viewer').addEventListener('mousedown', onViewerMousedown);
    document.addEventListener('mousemove', onDocMousemove);
    document.addEventListener('mouseup',   onDocMouseup);
  }

  /* ── page select + nav ─────────────────────────────────────── */
  // Wire up prev/next nav buttons and the page-select dropdown.
  function initPageSelect() {
    document.querySelectorAll('a.dp-nav-btn:not(.disabled)').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.preventDefault(); navigate(btn.getAttribute('href')); });
    });
    var pageSelect = document.getElementById('dp-page-select');
    if (pageSelect && C.pageList) {
      C.pageList.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.url;
        opt.textContent = 'p. ' + p.page_number;
        if (p.pk === C.currentPagePk) opt.selected = true;
        pageSelect.appendChild(opt);
      });
      pageSelect.addEventListener('change', function() { navigate(this.value); });
    }
  }

  /* ── keyboard ──────────────────────────────────────────────── */
  var _hooks = {};
  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
    if (e.key === 'ArrowLeft'  && !inInput && C.prevUrl) { navigate(C.prevUrl); return; }
    if (e.key === 'ArrowRight' && !inInput && C.nextUrl) { navigate(C.nextUrl); return; }
    if (C.hasRepair && (e.ctrlKey || e.metaKey) && !inInput) {
      if (e.key === 'z' && !e.shiftKey)                  { e.preventDefault(); if (_hooks.undo) _hooks.undo(); return; }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)){ e.preventDefault(); if (_hooks.redo) _hooks.redo(); return; }
    }
    var mod = _modules[state.activeTab];
    if (mod && mod.onKeydown) mod.onKeydown(e);
  });

  /* ── wheel zoom + coordinate readout ──────────────────────── */
  var wrapEl = document.getElementById('dp-viewer-wrap');
  if (wrapEl) {
    wrapEl.addEventListener('wheel', function(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY < 0) dpZoomIn(); else dpZoomOut();
    }, { passive: false });

    var coordEl = document.getElementById('dp-coord');
    if (coordEl) {
      wrapEl.addEventListener('mousemove', function(e) {
        var img = document.getElementById('dp-img');
        if (!img) return;
        var r = img.getBoundingClientRect();
        var ix = e.clientX - r.left, iy = e.clientY - r.top;
        if (ix < 0 || iy < 0 || ix > r.width || iy > r.height) { coordEl.style.display = 'none'; return; }
        var scale = getScale();
        coordEl.textContent = Math.round(ix / scale) + ', ' + Math.round(iy / scale);
        coordEl.style.display = 'block';
        var wr = wrapEl.getBoundingClientRect();
        coordEl.style.left = (wr.right  - coordEl.offsetWidth  - 8) + 'px';
        coordEl.style.top  = (wr.bottom - coordEl.offsetHeight - 8) + 'px';
      });
      wrapEl.addEventListener('mouseleave', function() { coordEl.style.display = 'none'; });
    }
  }

  return {
    state, C,
    get OCR_WORDS() { return OCR_WORDS; },
    set OCR_WORDS(v) { OCR_WORDS = v; },
    get TAGS() { return TAGS; },
    set TAGS(v) { TAGS = v; },
    wordById,
    postJson, positionAtViewerEdge, updateSelectBar, applyOcrWordDiff, withBtn, updateRubberBand,
    getScale, getRefWidth, viewerOffset, navigate, dpFit,
    renderOverlays, dpShowTab, updateBadge,
    registerModule,
    bindMouseHandlers,
    initPageSelect,
    setHook: function(name, fn) { _hooks[name] = fn; },
  };
}
