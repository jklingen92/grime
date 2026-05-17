// Image processing tab — brightness / contrast / levels with live preview.
//
// The preview is an SVG <feComponentTransfer> filter applied to #dp-img, so
// adjustments are visible from every tab without re-fetching pixels. Clicking
// "Save adjusted image" in the toolbar POSTs the current params to the
// backend, which bakes them into `corrected_image` using the same LUT formula
// (see _build_image_lut in viewer.py — keep the two in sync).
//
// Future adds (standard for document repair, deferred):
//   - Auto levels        — one-click ImageOps.autocontrast equivalent
//   - Grayscale toggle   — desaturate scans
//   - Invert             — negative for white-on-black originals
//   - Threshold/binarize — clean B/W for downstream OCR
//   - Sharpen            — Pillow UnsharpMask
//   - Rotate / deskew    — 90° buttons + fine-angle slider with white fill
//   - "Re-run OCR on corrected image" prompt after a save

export function createImageModule(core) {
  var state = core.state;
  var C     = core.C;

  // Slider-space defaults. brightness ÷100 → -1..1, contrast ÷100 → 0..2,
  // gamma ÷100 → 0.1..3.0. black/white are passed through as 0..255.
  var DEFAULTS = { brightness: 0, contrast: 100, gamma: 100, black: 0, white: 255 };

  state.imageSavedAdjustments = paramsToSliders(C.imageAdjustments) || Object.assign({}, DEFAULTS);
  state.imageAdjustments      = Object.assign({}, state.imageSavedAdjustments);
  state.imageHasCorrected     = !!C.imageHasCorrected;

  // Tracks the adjustment state at the last recorded undo boundary.
  var _prevAdjustments = null;

  // Preload the original so the first swap from corrected → original is instant.
  if (C.originalImageUrl && C.originalImageUrl !== C.imageUrl) {
    var pre = new Image(); pre.src = C.originalImageUrl;
  }

  // Convert backend params (floats / 0-255) to slider-space integers.
  function paramsToSliders(saved) {
    if (!saved) return null;
    return {
      brightness: Math.round((saved.brightness || 0) * 100),
      contrast:   Math.round((saved.contrast != null ? saved.contrast : 1) * 100),
      gamma:      Math.round((saved.gamma != null ? saved.gamma : 1) * 100),
      black:      saved.black || 0,
      white:      saved.white != null ? saved.white : 255,
    };
  }

  // Convert slider-space to canonical params posted to the backend.
  function slidersToParams(a) {
    return {
      brightness: a.brightness / 100,
      contrast:   a.contrast / 100,
      gamma:      a.gamma / 100,
      black:      a.black,
      white:      Math.max(a.black + 1, a.white),
    };
  }

  function buildLut(p) {
    var lut = new Array(256);
    var span = p.white - p.black;
    var invG = 1.0 / p.gamma;
    for (var i = 0; i < 256; i++) {
      var x = (i - p.black) / span;
      if (x < 0) x = 0; else if (x > 1) x = 1;
      x = Math.pow(x, invG);
      x = (x - 0.5) * p.contrast + 0.5;
      x = x + p.brightness;
      if (x < 0) x = 0; else if (x > 1) x = 1;
      lut[i] = x.toFixed(4);
    }
    return lut.join(' ');
  }

  function isIdentity(p) {
    return p.brightness === 0 && p.contrast === 1 && p.gamma === 1 &&
           p.black === 0 && p.white === 255;
  }

  function isDirty() {
    var a = state.imageAdjustments, s = state.imageSavedAdjustments;
    return a.brightness !== s.brightness || a.contrast !== s.contrast ||
           a.gamma !== s.gamma || a.black !== s.black || a.white !== s.white;
  }

  // Drive #dp-img to the right (src, filter) pair for the current state.
  function applyFilter() {
    var img = document.getElementById('dp-img');
    if (!img) return;
    var p = slidersToParams(state.imageAdjustments);
    var dirty = isDirty();

    var saveBtn = document.getElementById('dp-image-save-btn');
    if (saveBtn) saveBtn.style.display = dirty ? '' : 'none';

    if (!dirty && state.imageHasCorrected) {
      if (img.getAttribute('src') !== C.imageUrl) img.setAttribute('src', C.imageUrl);
      img.style.filter = '';
      return;
    }
    if (isIdentity(p)) {
      if (img.getAttribute('src') !== C.originalImageUrl) img.setAttribute('src', C.originalImageUrl);
      img.style.filter = '';
      return;
    }
    if (img.getAttribute('src') !== C.originalImageUrl) img.setAttribute('src', C.originalImageUrl);
    var table = buildLut(p);
    ['r', 'g', 'b'].forEach(function(ch) {
      var el = document.getElementById('dp-image-filter-' + ch);
      if (el) el.setAttribute('tableValues', table);
    });
    img.style.filter = 'url(#dp-image-filter)';
  }

  function formatVal(key, v) {
    if (key === 'contrast' || key === 'gamma') return (v / 100).toFixed(2);
    if (key === 'brightness') return (v > 0 ? '+' : '') + v;
    return String(v);
  }

  function syncSliders() {
    ['brightness', 'contrast', 'gamma', 'black', 'white'].forEach(function(key) {
      var s = document.getElementById('dp-image-' + key);
      var l = document.getElementById('dp-image-' + key + '-val');
      if (s) s.value = state.imageAdjustments[key];
      if (l) l.textContent = formatVal(key, state.imageAdjustments[key]);
    });
  }

  function onSlide(key, value) {
    state.imageAdjustments[key] = parseInt(value, 10);
    var l = document.getElementById('dp-image-' + key + '-val');
    if (l) l.textContent = formatVal(key, state.imageAdjustments[key]);
    applyFilter();
  }

  function resetLocal() {
    var prev = Object.assign({}, state.imageAdjustments);
    state.imageAdjustments = Object.assign({}, DEFAULTS);
    var next = Object.assign({}, DEFAULTS);
    core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
    _prevAdjustments = next;
    syncSliders();
    applyFilter();
  }

  // Returns a Promise<boolean> — true if the save (or reset) succeeded.
  function save() {
    var btn = document.getElementById('dp-image-save-btn');
    var p = slidersToParams(state.imageAdjustments);
    var url = isIdentity(p) ? C.imageResetUrl : C.imageSaveUrl;
    var init = isIdentity(p)
      ? { method: 'POST', headers: { 'X-CSRFToken': C.csrfToken } }
      : { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': C.csrfToken },
          body: JSON.stringify(p) };

    return core.withBtn(btn, 'Saving…', function() {
      return fetch(url, init)
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function(data) {
          if (!data.ok) { alert(data.error || 'Save failed.'); return false; }
          // Mark current params as the saved baseline BEFORE touching the DOM,
          // so applyFilter() sees a clean state and hides the save button.
          state.imageSavedAdjustments = Object.assign({}, state.imageAdjustments);
          state.imageHasCorrected = !isIdentity(p);
          if (data.image_url) {
            var sep = data.image_url.indexOf('?') >= 0 ? '&' : '?';
            C.imageUrl = data.image_url + sep + 't=' + Date.now();
          }
          applyFilter();
          return true;
        })
        .catch(function(err) {
          console.error('Image save failed:', err);
          alert('Save failed: ' + (err && err.message ? err.message : err));
          return false;
        });
    });
  }

  // If adjustments are clean, run onContinue() immediately. Otherwise show the
  // unsaved-adjustments bar and route the user's choice to onContinue() (after
  // an optional save) or abort. Used by other modules (e.g. OCR) before any
  // action that reads pixels from the server.
  function imageEnsureSaved(onContinue) {
    if (!isDirty()) { onContinue(); return; }
    var bar    = document.getElementById('dp-image-unsaved-bar');
    var saveB  = document.getElementById('dp-image-unsaved-save');
    var skipB  = document.getElementById('dp-image-unsaved-skip');
    var cancB  = document.getElementById('dp-image-unsaved-cancel');
    if (!bar || !saveB || !skipB || !cancB) { onContinue(); return; }
    core.positionAtViewerEdge(bar);
    bar.style.display = 'flex';
    function cleanup() {
      bar.style.display = 'none';
      saveB.onclick = skipB.onclick = cancB.onclick = null;
    }
    saveB.onclick = function() { cleanup(); save().then(function(ok) { if (ok) onContinue(); }); };
    skipB.onclick = function() { cleanup(); onContinue(); };
    cancB.onclick = function() { cleanup(); };
  }

  function setupUI() {
    _prevAdjustments = Object.assign({}, state.imageAdjustments);

    ['brightness', 'contrast', 'gamma', 'black', 'white'].forEach(function(key) {
      var s = document.getElementById('dp-image-' + key);
      if (!s) return;
      s.addEventListener('input',  function() { onSlide(key, s.value); });
      s.addEventListener('change', function() {
        var next = Object.assign({}, state.imageAdjustments);
        if (JSON.stringify(_prevAdjustments) !== JSON.stringify(next)) {
          core.recordUndo({ type: 'image-adjust', prev: _prevAdjustments, next: next });
          _prevAdjustments = next;
        }
      });
    });

    var resetBtn = document.getElementById('dp-image-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', function(e) { e.preventDefault(); resetLocal(); });
    var saveBtn = document.getElementById('dp-image-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function(e) { e.preventDefault(); save(); });

    core.registerUndoHandler('image-adjust', function(e, pushInverse) {
      pushInverse({ type: 'image-adjust', prev: e.next, next: e.prev });
      state.imageAdjustments = Object.assign({}, e.prev);
      _prevAdjustments = Object.assign({}, e.prev);
      syncSliders(); applyFilter();
    });

    core.imageEnsureSaved = imageEnsureSaved;
    syncSliders();
    applyFilter();
  }

  // No overlays of our own — the side panel and the global save button do it all.
  function render() {}
  function activate() {
    var sb = document.getElementById('dp-image-save-btn');
    if (sb) sb.style.display = isDirty() ? '' : 'none';
  }

  return { render, setupUI, activate };
}
