// Image processing tab — brightness / contrast / levels / grayscale / invert /
// threshold / sharpen / rotate with live preview.
//
// The preview is an SVG <feComponentTransfer> filter applied to #dp-img, so
// adjustments are visible from every tab without re-fetching pixels. Clicking
// "Save adjusted image" in the toolbar POSTs the current params to the
// backend, which bakes them into `corrected_image` using the same LUT formula
// (see _build_image_lut in viewer.py — keep the two in sync).

export function createImageModule(core) {
  var state = core.state;
  var C     = core.C;

  // Slider-space defaults. brightness ÷100 → -1..1, contrast ÷100 → 0..2,
  // gamma ÷100 → 0.1..3.0. black/white are 0..255. rotateFine is ±5 degrees.
  var DEFAULTS = {
    brightness: 0, contrast: 100, gamma: 100, black: 0, white: 255,
    grayscale: false, invert: false, threshold: null, sharpen: false,
    rotate90: 0, rotateFine: 0,
  };

  state.imageSavedAdjustments = paramsToSliders(C.imageAdjustments) || Object.assign({}, DEFAULTS);
  state.imageAdjustments      = Object.assign({}, state.imageSavedAdjustments);
  state.imageHasCorrected     = !!C.imageHasCorrected;

  // Tracks the adjustment state at the last recorded undo boundary.
  var _prevAdjustments = null;

  // Preload the original so the first swap from corrected → original is instant.
  if (C.originalImageUrl && C.originalImageUrl !== C.imageUrl) {
    var pre = new Image(); pre.src = C.originalImageUrl;
  }

  // Convert backend params (floats / 0-255) to slider-space.
  function paramsToSliders(saved) {
    if (!saved) return null;
    return {
      brightness: Math.round((saved.brightness || 0) * 100),
      contrast:   Math.round((saved.contrast != null ? saved.contrast : 1) * 100),
      gamma:      Math.round((saved.gamma != null ? saved.gamma : 1) * 100),
      black:      saved.black || 0,
      white:      saved.white != null ? saved.white : 255,
      grayscale:  !!saved.grayscale,
      invert:     !!saved.invert,
      threshold:  saved.threshold != null ? parseInt(saved.threshold, 10) : null,
      sharpen:    !!saved.sharpen,
      rotate90:   saved.rotate90 != null ? ((parseInt(saved.rotate90, 10) % 4 + 4) % 4) : 0,
      rotateFine: saved.rotate_fine != null ? parseFloat(saved.rotate_fine) : 0,
    };
  }

  // Convert slider-space to canonical params posted to the backend.
  function slidersToParams(a) {
    return {
      brightness:  a.brightness / 100,
      contrast:    a.contrast / 100,
      gamma:       a.gamma / 100,
      black:       a.black,
      white:       Math.max(a.black + 1, a.white),
      grayscale:   !!a.grayscale,
      invert:      !!a.invert,
      threshold:   a.threshold != null ? parseInt(a.threshold, 10) : null,
      sharpen:     !!a.sharpen,
      rotate90:    a.rotate90 || 0,
      rotate_fine: a.rotateFine || 0,
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

  function isIdentityLut(p) {
    return p.brightness === 0 && p.contrast === 1 && p.gamma === 1 &&
           p.black === 0 && p.white === 255;
  }

  function isIdentity(p) {
    return isIdentityLut(p) &&
           !p.grayscale && !p.invert && p.threshold == null && !p.sharpen &&
           !p.rotate90 && !p.rotate_fine;
  }

  function isDirty() {
    var a = state.imageAdjustments, s = state.imageSavedAdjustments;
    return a.brightness !== s.brightness || a.contrast !== s.contrast ||
           a.gamma !== s.gamma || a.black !== s.black || a.white !== s.white ||
           !!a.grayscale !== !!s.grayscale || !!a.invert !== !!s.invert ||
           a.threshold !== s.threshold || !!a.sharpen !== !!s.sharpen ||
           a.rotate90 !== s.rotate90 || a.rotateFine !== s.rotateFine;
  }

  // Drive #dp-img to the right (src, filter, transform) for the current state.
  function applyFilter() {
    var img = document.getElementById('dp-img');
    if (!img) return;
    var sliders = state.imageAdjustments;
    var p = slidersToParams(sliders);
    var dirty = isDirty();

    var saveBtn = document.getElementById('dp-image-save-btn');
    if (saveBtn) saveBtn.style.display = dirty ? '' : 'none';

    // Clean state with a saved corrected image — show it unmodified.
    if (!dirty && state.imageHasCorrected) {
      if (img.getAttribute('src') !== C.imageUrl) img.setAttribute('src', C.imageUrl);
      img.style.filter    = '';
      img.style.transform = '';
      return;
    }

    // Always preview against the original (adjustments are not yet baked).
    if (img.getAttribute('src') !== C.originalImageUrl) img.setAttribute('src', C.originalImageUrl);

    if (isIdentity(p)) {
      img.style.filter    = '';
      img.style.transform = '';
      return;
    }

    // Build CSS filter chain --------------------------------------------------
    var filters = [];

    // LUT (brightness / contrast / gamma / levels)
    if (!isIdentityLut(p)) {
      var table = buildLut(p);
      ['r', 'g', 'b'].forEach(function(ch) {
        var el = document.getElementById('dp-image-filter-' + ch);
        if (el) el.setAttribute('tableValues', table);
      });
      filters.push('url(#dp-image-filter)');
    }

    if (sliders.grayscale) filters.push('grayscale(1)');
    if (sliders.invert)    filters.push('invert(1)');

    // Threshold: steep linear slope creates a sharp step at t/255.
    if (sliders.threshold !== null) {
      var t = sliders.threshold / 255;
      var slope = 1000;
      var intercept = -(t * slope);
      ['r', 'g', 'b'].forEach(function(ch) {
        var el = document.getElementById('dp-threshold-filter-' + ch);
        if (el) {
          el.setAttribute('slope', String(slope));
          el.setAttribute('intercept', intercept.toFixed(1));
        }
      });
      filters.push('url(#dp-threshold-filter)');
    }

    img.style.filter = filters.join(' ');

    // Rotation via CSS transform (positive = clockwise, matching Pillow convention).
    var totalDeg = sliders.rotate90 * 90 + sliders.rotateFine;
    img.style.transform = totalDeg ? 'rotate(' + totalDeg + 'deg)' : '';
  }

  function formatVal(key, v) {
    if (key === 'contrast' || key === 'gamma') return (v / 100).toFixed(2);
    if (key === 'brightness') return (v > 0 ? '+' : '') + v;
    return String(v);
  }

  function syncSliders() {
    // Numeric sliders
    ['brightness', 'contrast', 'gamma', 'black', 'white'].forEach(function(key) {
      var s = document.getElementById('dp-image-' + key);
      var l = document.getElementById('dp-image-' + key + '-val');
      if (s) s.value = state.imageAdjustments[key];
      if (l) l.textContent = formatVal(key, state.imageAdjustments[key]);
    });

    // Toggle buttons
    ['grayscale', 'invert', 'sharpen'].forEach(function(key) {
      var btn = document.getElementById('dp-image-' + key + '-btn');
      if (btn) btn.classList.toggle('active', !!state.imageAdjustments[key]);
    });

    // Sharpen note
    var sharpenNote = document.getElementById('dp-image-sharpen-note');
    if (sharpenNote) sharpenNote.style.display = state.imageAdjustments.sharpen ? '' : 'none';

    // Threshold
    var threshEnable = document.getElementById('dp-image-threshold-enable');
    var threshSlider = document.getElementById('dp-image-threshold');
    var threshVal    = document.getElementById('dp-image-threshold-val');
    var threshActive = state.imageAdjustments.threshold !== null;
    if (threshEnable) threshEnable.checked = threshActive;
    if (threshSlider) {
      threshSlider.disabled = !threshActive;
      if (threshActive) threshSlider.value = state.imageAdjustments.threshold;
    }
    if (threshVal) threshVal.textContent = threshActive ? String(state.imageAdjustments.threshold) : '—';

    // Fine rotate
    var rotFine    = document.getElementById('dp-image-rotate-fine');
    var rotFineVal = document.getElementById('dp-image-rotate-fine-val');
    if (rotFine) rotFine.value = state.imageAdjustments.rotateFine;
    if (rotFineVal) {
      var f = state.imageAdjustments.rotateFine;
      rotFineVal.textContent = (f > 0 ? '+' : '') + f.toFixed(1) + '°';
    }
  }

  function onSlide(key, value) {
    state.imageAdjustments[key] = parseInt(value, 10);
    var l = document.getElementById('dp-image-' + key + '-val');
    if (l) l.textContent = formatVal(key, state.imageAdjustments[key]);
    applyFilter();
  }

  function recordAdjustUndo() {
    var next = Object.assign({}, state.imageAdjustments);
    if (JSON.stringify(_prevAdjustments) !== JSON.stringify(next)) {
      core.recordUndo({ type: 'image-adjust', prev: _prevAdjustments, next: next });
      _prevAdjustments = next;
    }
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

    // Numeric sliders (existing five keys)
    ['brightness', 'contrast', 'gamma', 'black', 'white'].forEach(function(key) {
      var s = document.getElementById('dp-image-' + key);
      if (!s) return;
      s.addEventListener('input',  function() { onSlide(key, s.value); });
      s.addEventListener('change', function() { recordAdjustUndo(); });
    });

    // Fine-rotate slider (float values, step=0.1)
    var rotFine = document.getElementById('dp-image-rotate-fine');
    if (rotFine) {
      rotFine.addEventListener('input', function() {
        state.imageAdjustments.rotateFine = parseFloat(rotFine.value);
        var l = document.getElementById('dp-image-rotate-fine-val');
        if (l) {
          var f = state.imageAdjustments.rotateFine;
          l.textContent = (f > 0 ? '+' : '') + f.toFixed(1) + '°';
        }
        applyFilter();
      });
      rotFine.addEventListener('change', function() { recordAdjustUndo(); });
    }

    // Toggle buttons (grayscale / invert / sharpen)
    function wireToggle(key) {
      var btn = document.getElementById('dp-image-' + key + '-btn');
      if (!btn) return;
      btn.addEventListener('click', function() {
        var prev = Object.assign({}, state.imageAdjustments);
        state.imageAdjustments[key] = !state.imageAdjustments[key];
        var next = Object.assign({}, state.imageAdjustments);
        core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
        _prevAdjustments = next;
        syncSliders();
        applyFilter();
      });
    }
    wireToggle('grayscale');
    wireToggle('invert');
    wireToggle('sharpen');

    // Threshold enable checkbox + slider
    var threshEnable = document.getElementById('dp-image-threshold-enable');
    var threshSlider = document.getElementById('dp-image-threshold');
    if (threshEnable && threshSlider) {
      threshEnable.addEventListener('change', function() {
        var prev = Object.assign({}, state.imageAdjustments);
        if (threshEnable.checked) {
          state.imageAdjustments.threshold = parseInt(threshSlider.value, 10);
          threshSlider.disabled = false;
        } else {
          state.imageAdjustments.threshold = null;
          threshSlider.disabled = true;
        }
        var next = Object.assign({}, state.imageAdjustments);
        core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
        _prevAdjustments = next;
        syncSliders();
        applyFilter();
      });
      threshSlider.addEventListener('input', function() {
        if (state.imageAdjustments.threshold !== null) {
          state.imageAdjustments.threshold = parseInt(threshSlider.value, 10);
          var l = document.getElementById('dp-image-threshold-val');
          if (l) l.textContent = String(state.imageAdjustments.threshold);
          applyFilter();
        }
      });
      threshSlider.addEventListener('change', function() { recordAdjustUndo(); });
    }

    // 90° rotate buttons
    var rotateCcwBtn = document.getElementById('dp-image-rotate-ccw-btn');
    var rotateCwBtn  = document.getElementById('dp-image-rotate-cw-btn');
    if (rotateCcwBtn) {
      rotateCcwBtn.addEventListener('click', function() {
        var prev = Object.assign({}, state.imageAdjustments);
        state.imageAdjustments.rotate90 = (state.imageAdjustments.rotate90 + 3) % 4;
        var next = Object.assign({}, state.imageAdjustments);
        core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
        _prevAdjustments = next;
        applyFilter();
      });
    }
    if (rotateCwBtn) {
      rotateCwBtn.addEventListener('click', function() {
        var prev = Object.assign({}, state.imageAdjustments);
        state.imageAdjustments.rotate90 = (state.imageAdjustments.rotate90 + 1) % 4;
        var next = Object.assign({}, state.imageAdjustments);
        core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
        _prevAdjustments = next;
        applyFilter();
      });
    }

    // Auto-contrast: fetch suggested black/white levels from the histogram
    var autoContrastBtn = document.getElementById('dp-image-autocontrast-btn');
    if (autoContrastBtn && C.imageAutocontrastUrl) {
      autoContrastBtn.addEventListener('click', function() {
        core.withBtn(autoContrastBtn, 'Analysing…', function() {
          return fetch(C.imageAutocontrastUrl, {
            method: 'POST',
            headers: { 'X-CSRFToken': C.csrfToken },
          })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.ok) { alert(data.error || 'Auto contrast failed.'); return; }
              var prev = Object.assign({}, state.imageAdjustments);
              state.imageAdjustments.black = data.black;
              state.imageAdjustments.white = data.white;
              var next = Object.assign({}, state.imageAdjustments);
              core.recordUndo({ type: 'image-adjust', prev: prev, next: next });
              _prevAdjustments = next;
              syncSliders();
              applyFilter();
            })
            .catch(function(err) { alert('Auto contrast failed: ' + (err && err.message ? err.message : err)); });
        });
      });
    }

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
