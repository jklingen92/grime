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
    state.imageAdjustments = Object.assign({}, DEFAULTS);
    syncSliders();
    applyFilter();
  }

  function save() {
    var btn = document.getElementById('dp-image-save-btn');
    var p = slidersToParams(state.imageAdjustments);

    // Identity == clearing corrected_image on the server.
    if (isIdentity(p)) {
      core.withBtn(btn, 'Saving…', function() {
        return fetch(C.imageResetUrl, {
          method: 'POST',
          headers: { 'X-CSRFToken': C.csrfToken },
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) { alert(data.error || 'Reset failed.'); return; }
          state.imageSavedAdjustments = Object.assign({}, DEFAULTS);
          state.imageHasCorrected = false;
          applyFilter();
        });
      });
      return;
    }

    core.withBtn(btn, 'Saving…', function() {
      return fetch(C.imageSaveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': C.csrfToken },
        body: JSON.stringify(p),
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) { alert(data.error || 'Save failed.'); return; }
        state.imageSavedAdjustments = Object.assign({}, state.imageAdjustments);
        state.imageHasCorrected = true;
        // Cache-bust so the browser reloads from the freshly written file.
        var bust = data.image_url + (data.image_url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
        C.imageUrl = bust;
        var img = document.getElementById('dp-img');
        if (img) { img.setAttribute('src', bust); img.style.filter = ''; }
        var sb = document.getElementById('dp-image-save-btn');
        if (sb) sb.style.display = 'none';
      });
    });
  }

  function setupUI() {
    ['brightness', 'contrast', 'gamma', 'black', 'white'].forEach(function(key) {
      var s = document.getElementById('dp-image-' + key);
      if (s) s.addEventListener('input', function() { onSlide(key, s.value); });
    });
    var resetBtn = document.getElementById('dp-image-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', function(e) { e.preventDefault(); resetLocal(); });
    var saveBtn = document.getElementById('dp-image-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function(e) { e.preventDefault(); save(); });
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
