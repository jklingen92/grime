(function () {
  var C              = window.VIEWER_CONFIG;
  var CITATIONS      = C.citations;
  var OCR_WORDS      = C.ocrWords;
  var HAS_REPAIR     = C.hasRepair;
  var PREV_URL       = C.prevUrl;
  var NEXT_URL       = C.nextUrl;
  var TAGS           = C.tags;
  var TAG_CREATE_URL = C.tagCreateUrl;
  var TAG_UPDATE_URL = C.tagUpdateUrl;
  var TAG_DELETE_URL = C.tagDeleteUrl;
  var NER_CORRECT_URL = C.nerCorrectUrl;
  var TAG_SOURCE_TYPE_ID = C.tagSourceTypeId;
  var TAG_SOURCE_ID  = C.tagSourceId;
  var CSRF_TOKEN     = C.csrfToken;
  var CORRECT_URL    = C.correctUrl;
  var MERGE_URL      = C.mergeUrl;
  var DELETE_URL     = C.deleteUrl;
  var ADD_WORD_URL   = C.addWordUrl;
  var REORDER_URL    = C.reorderUrl;
  var JOIN_LINE_URL  = C.joinLineUrl;
  var CONFIRM_ALL_URL = C.confirmAllUrl;
  var RECLUSTER_URL  = C.reclusterUrl;
  var CREATE_PERSON_URL = C.createPersonUrl;
  var RERUN_OCR_URL      = C.rerunOcrUrl || null;
  var CLEAR_WORDS_URL    = C.clearWordsUrl || null;
  var RESOLVE_DITTOS_URL = C.resolveDittosUrl || null;
  var MARK_AS_DITTO_URL  = C.markAsDittoUrl || null;
  var BULK_DITTO_URL     = C.bulkDittoUrl || null;
  var BULK_DELETE_URL    = C.bulkDeleteUrl || null;
  var PAGE_LIST      = C.pageList || null;
  var CURRENT_PAGE_PK = C.currentPagePk || null;

  var wordById = {};
  OCR_WORDS.forEach(function (w) { if (w.id != null) wordById[w.id] = w; });

  var state = {
    activeTab:          new URLSearchParams(window.location.search).get('tab') || 'ocr',
    zoomLevel:          1.0,
    // tag draw/edit
    tagPhase:           'draw', // 'draw' | 'labeling'
    tagDrawStart:       null,   // {x, y} in client coords
    tagPendingBbox:     null,   // {left,top,width,height} in image px
    tagEditingId:       null,   // null=new, int=existing
    tagPendingLabel:    '',
    tagPendingSubcomps: [],     // [{word_id,label,text}]
    tagSubSelectedIds:  new Set(),
    tagSubDrawStart:    null,
    tagResizing:        null,   // {corner, startX, startY, startBbox}
    // NER
    nerPopupWordId:     null,
    // person
    personGroupsLoaded: false,
    // OCR interaction
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
  };
  window._viewerState = state;

  function navigate(url) {
    if (!url) return;
    window.location.href = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tab=' + state.activeTab;
  }

  /* ── zoom ──────────────────────────────────────────────────── */
  function applyZoom() {
    var img = document.getElementById('dp-img');
    if (!img) return;
    img.style.width = Math.round(img.naturalWidth * state.zoomLevel) + 'px';
    renderOverlays();
    if (state.tagPhase === 'labeling' && state.tagPendingBbox) tagUpdateVeils();
    document.getElementById('dp-zoom-label').textContent = Math.round(state.zoomLevel * 100) + '%';
  }
  function dpFit() {
    var img = document.getElementById('dp-img'), wrap = document.getElementById('dp-viewer-wrap');
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    var aw = wrap.parentElement.clientWidth - 4, ah = Math.round(window.innerHeight * 0.8) - 4;
    state.zoomLevel = Math.min(1.0, (aw / img.naturalWidth + ah / img.naturalHeight) / 2);
    applyZoom();
  }
  function dpZoomIn()    { state.zoomLevel = Math.min(state.zoomLevel + 0.25, 4.0); applyZoom(); }
  function dpZoomOut()   { state.zoomLevel = Math.max(state.zoomLevel - 0.25, 0.25); applyZoom(); }
  function dpZoomReset() { dpFit(); }
  window.dpZoomIn = dpZoomIn; window.dpZoomOut = dpZoomOut; window.dpZoomReset = dpZoomReset;

  /*
   * getRefWidth: the coordinate space in which OCR bboxes were generated.
   * For articles, Tesseract/Textract normalise to max(naturalWidth, 2000).
   * For document pages rendered at 200 DPI, naturalWidth is the bbox space.
   */
  function getRefWidth() {
    var img = document.getElementById('dp-img');
    if (!img || !img.naturalWidth) return 1;
    return C.usePreprocessedBbox ? Math.max(img.naturalWidth, 2000) : img.naturalWidth;
  }
  function getScale() {
    var img = document.getElementById('dp-img');
    return img ? img.clientWidth / getRefWidth() : 1;
  }

  /* ── tabs ──────────────────────────────────────────────────── */
  function dpShowTab(name) {
    if (state.tagPhase === 'labeling') tagExitLabelingMode();
    state.activeTab = name;
    document.getElementById('tab-tagging').classList.toggle('active', name === 'tagging');
    document.getElementById('tab-ocr').classList.toggle('active', name === 'ocr');
    var actions   = document.getElementById('dp-ocr-actions');
    var sep       = document.getElementById('dp-sep-ocr');
    var tagP      = document.getElementById('dp-tag-panel');
    var txtP      = document.getElementById('dp-text-panel');
    var nerLegend = document.getElementById('dp-tag-ner-legend');
    if (name === 'ocr') {
      if (actions) { actions.classList.add('visible'); if (sep) sep.style.display = ''; }
      if (tagP) tagP.classList.remove('visible');
      if (txtP) txtP.classList.add('visible');
      clearOcrSelection();
    } else {
      if (nerLegend) {
        var hasNer = OCR_WORDS.some(function(w){ return w.ner_label || w.corrected_ner_label; });
        nerLegend.style.display = hasNer ? 'flex' : 'none';
      }
      if (actions) { actions.classList.remove('visible'); if (sep) sep.style.display = 'none'; }
      if (tagP) tagP.classList.add('visible');
      if (txtP) txtP.classList.remove('visible');
      clearOcrSelection();
    }
    renderOverlays(); updateBadge();
  }
  window.dpShowTab = dpShowTab;

  function updateBadge() {
    var el = document.getElementById('dp-tab-badge');
    if (!el) return;
    if (state.activeTab === 'tagging') {
      el.textContent = TAGS.length ? TAGS.length + ' tag' + (TAGS.length === 1 ? '' : 's') : 'No tags';
    } else {
      el.textContent = OCR_WORDS.length ? OCR_WORDS.length + ' word' + (OCR_WORDS.length === 1 ? '' : 's') : 'No OCR data';
    }
  }

  /* ── tagging: list ─────────────────────────────────────────── */
  function tagBuildList() {
    var list = document.getElementById('dp-tag-list');
    if (!list) return;
    list.innerHTML = '';
    if (!TAGS.length) {
      list.innerHTML = '<div id="dp-tag-empty">No tags yet. Drag to create one.</div>';
      return;
    } 
    TAGS.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'dp-tag-item';
      item.dataset.tagId = t.id;
      var title = document.createElement('div');
      title.textContent = t.label;
      item.appendChild(title);
      if (t.subcomponents && t.subcomponents.length) {
        var sub = document.createElement('div');
        sub.className = 'dp-tag-item-sub';
        sub.textContent = t.subcomponents.map(function(s){ return s.label + ': ' + s.text; }).join(' · ');
        item.appendChild(sub);
      }
      item.addEventListener('click', function () { tagOpenExisting(t); });
      list.appendChild(item);
    });
  }

  /* ── tagging: overlay rendering ────────────────────────────── */
  function tagRenderTagOverlays() {
    var viewer = document.getElementById('dp-viewer');
    if (!viewer) return;
    viewer.querySelectorAll('.dp-tag-overlay').forEach(function(el){ el.remove(); });
    var scale = getScale();
    TAGS.forEach(function (t) {
      var div = document.createElement('div');
      div.className = 'dp-tag-overlay' + (t.autogenerated ? ' autogenerated' : '');
      div.dataset.tagId = t.id;
      div.style.left   = Math.round(t.bbox_left   * scale) + 'px';
      div.style.top    = Math.round(t.bbox_top    * scale) + 'px';
      div.style.width  = Math.round(t.bbox_width  * scale) + 'px';
      div.style.height = Math.round(t.bbox_height * scale) + 'px';
      div.title = t.label + ' (click to edit)';
      var lbl = document.createElement('div');
      lbl.className = 'dp-tag-overlay-label';
      lbl.textContent = t.label;
      div.appendChild(lbl);
      viewer.appendChild(div);
    });
  }

  /* ── tagging: open existing ─────────────────────────────────── */
  function tagOpenExisting(tag) {
    state.tagEditingId      = tag.id;
    state.tagPendingLabel   = tag.label;
    state.tagPendingSubcomps = tag.subcomponents ? tag.subcomponents.slice() : [];
    state.tagPendingBbox    = { left: tag.bbox_left, top: tag.bbox_top, width: tag.bbox_width, height: tag.bbox_height };
    tagEnterLabelingMode();
    document.getElementById('dp-tag-delete-btn').style.display = '';
  }

  /* ── tagging: enter / exit labeling mode ────────────────────── */
  function tagEnterLabelingMode() {
    state.tagPhase = 'labeling';
    state.tagSubSelectedIds.clear();

    // For new tags, pre-populate subcomponents from NER labels
    if (!state.tagEditingId && state.tagPendingBbox) {
      nerSuggestSubcomps(state.tagPendingBbox);
    }

    // Show labeling panel
    document.getElementById('dp-tag-list-view').style.display = 'none';
    document.getElementById('dp-tag-label-view').style.display = 'flex';
    document.getElementById('dp-tag-label-heading').textContent = state.tagEditingId ? 'Edit tag' : 'New tag';
    var labelInput = document.getElementById('dp-tag-label-input');
    labelInput.value = state.tagPendingLabel;
    document.getElementById('dp-tag-delete-btn').style.display = 'none';
    document.getElementById('dp-tag-sub-input-row').style.display = 'none';
    tagUpdateSubcompDisplay();

    // Show active region outline + veils
    tagUpdateVeils();
    renderOverlays();
    labelInput.focus();
    labelInput.select();
  }

  function tagExitLabelingMode() {
    state.tagPhase = 'draw';
    state.tagEditingId = null;
    state.tagPendingLabel = '';
    state.tagPendingSubcomps = [];
    state.tagPendingBbox = null;
    state.tagSubSelectedIds.clear();
    state.tagSubDrawStart = null;
    state.isDragging = false;
    state.tagResizing = null;

    // Hide labeling panel, show list
    document.getElementById('dp-tag-label-view').style.display = 'none';
    document.getElementById('dp-tag-list-view').style.display = '';
    document.getElementById('dp-tag-sub-input-row').style.display = 'none';

    // Hide active rect + veils
    document.getElementById('dp-tag-active-rect').style.display = 'none';
    document.getElementById('dp-tag-sub-rect').style.display = 'none';
    ['dp-veil-top','dp-veil-bottom','dp-veil-left','dp-veil-right'].forEach(function(id){
      document.getElementById(id).style.display = 'none';
    });

    tagBuildList();
    tagRenderTagOverlays();
    renderOverlays();
    updateBadge();
  }

  /* ── tagging: veils ────────────────────────────────────────── */
  function tagUpdateVeils() {
    if (!state.tagPendingBbox) return;
    var viewer = document.getElementById('dp-viewer');
    var scale  = getScale();
    var bx = Math.round(state.tagPendingBbox.left   * scale);
    var by = Math.round(state.tagPendingBbox.top    * scale);
    var bw = Math.round(state.tagPendingBbox.width  * scale);
    var bh = Math.round(state.tagPendingBbox.height * scale);
    var vw = viewer.offsetWidth, vh = viewer.offsetHeight;

    function setVeil(id, l, t, w, h) {
      var el = document.getElementById(id);
      el.style.left = l + 'px'; el.style.top = t + 'px';
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.style.display = (w > 0 && h > 0) ? '' : 'none';
    }
    setVeil('dp-veil-top',    0,     0,     vw,    by);
    setVeil('dp-veil-bottom', 0,     by+bh, vw,    Math.max(0, vh - by - bh));
    setVeil('dp-veil-left',   0,     by,    bx,    bh);
    setVeil('dp-veil-right',  bx+bw, by,    Math.max(0, vw - bx - bw), bh);

    var ar = document.getElementById('dp-tag-active-rect');
    ar.style.left = bx + 'px'; ar.style.top = by + 'px';
    ar.style.width = bw + 'px'; ar.style.height = bh + 'px';
    ar.style.display = 'block';
  }

  /* ── tagging: subcomp display ───────────────────────────────── */
  function tagUpdateSubcompDisplay() {
    var list = document.getElementById('dp-tag-subcomp-list');
    list.innerHTML = '';
    var firstSelected = null;
    state.tagPendingSubcomps.forEach(function (sc, i) {
      var isSelected = state.tagSubSelectedIds.has(sc.word_id);
      var row = document.createElement('div');
      row.className = 'dp-subcomp-row' + (isSelected ? ' highlighted' : '');
      var lbl = document.createElement('span'); lbl.className = 'dp-subcomp-label'; lbl.textContent = sc.label + ':';
      var txt = document.createElement('span'); txt.className = 'dp-subcomp-text';  txt.textContent = sc.text;
      var rm  = document.createElement('span'); rm.className  = 'dp-subcomp-rm';    rm.textContent  = '×';
      rm.title = 'Remove from pattern';
      (function(idx){ rm.addEventListener('click', function(e){
        e.stopPropagation();
        var wid = state.tagPendingSubcomps[idx].word_id;
        state.tagSubSelectedIds.delete(wid);
        state.tagPendingSubcomps.splice(idx, 1);
        tagMaybeShowSubInput();
        tagUpdateSubcompDisplay();
        renderOverlays();
      }); })(i);
      // Clicking the row (not ×) toggles selection
      (function(wid){ row.addEventListener('click', function(e) {
        if (e.target.classList.contains('dp-subcomp-rm')) return;
        if (state.tagSubSelectedIds.has(wid)) state.tagSubSelectedIds.delete(wid);
        else state.tagSubSelectedIds.add(wid);
        tagMaybeShowSubInput();
        tagUpdateSubcompDisplay();
        renderOverlays();
      }); })(sc.word_id);
      row.appendChild(lbl); row.appendChild(txt); row.appendChild(rm);
      list.appendChild(row);
      if (isSelected && !firstSelected) firstSelected = row;
    });
    if (firstSelected) firstSelected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    renderOverlays();
  }

  /* ── ditto mark helpers ─────────────────────────────────────── */
  function isDitto(text) {
    var t = text.trim();
    return /^["'«»''""″〃〞＂]+$/.test(t) ||
           t === '""' || t === "''" || t === '``';
  }

  function resolveDitto(label, currentTop) {
    // Find the most recent tag (vertically above) that has a subcomp with the same label
    var candidates = TAGS.filter(function(t) {
      return t.bbox_top + t.bbox_height <= currentTop + 8;
    });
    candidates.sort(function(a, b) { return b.bbox_top - a.bbox_top; });
    for (var i = 0; i < candidates.length; i++) {
      var sc = (candidates[i].subcomponents || []).find(function(s) { return s.label === label; });
      if (sc && sc.text && !isDitto(sc.text)) return sc.text;
    }
    return null;
  }

  /* ── tagging: sub-label confirm ─────────────────────────────── */
  function tagConfirmSubLabel(label) {
    label = label.trim();
    if (!label || !state.tagSubSelectedIds.size) return;
    state.tagSubSelectedIds.forEach(function(wid){
      var w = wordById[wid];
      if (!w) return;
      var existing = state.tagPendingSubcomps.find(function(s){ return s.word_id === wid; });
      if (existing) {
        // Already tagged — only update the label, preserve the text
        existing.label = label;
      } else {
        var text = (w.corrected_text != null ? w.corrected_text : w.text) || '';
        if (isDitto(text) && state.tagPendingBbox) {
          var resolved = resolveDitto(label, state.tagPendingBbox.top);
          if (resolved) text = resolved;
        }
        state.tagPendingSubcomps.push({ word_id: wid, label: label, text: text });
      }
    });
    state.tagSubSelectedIds.clear();
    document.getElementById('dp-tag-sub-input').value = '';
    document.getElementById('dp-tag-sub-input-row').style.display = 'none';
    tagUpdateSubcompDisplay();
    tagPopulateLabelDatalist();
  }

  function _commonSelectedLabel() {
    var seen = null;
    var all = true;
    state.tagSubSelectedIds.forEach(function(wid) {
      var sc = state.tagPendingSubcomps.find(function(s){ return s.word_id === wid; });
      if (!sc) { all = false; return; }
      if (seen === null) seen = sc.label;
      else if (seen !== sc.label) all = false;
    });
    return (all && seen !== null) ? seen : '';
  }

  function tagMaybeShowSubInput() {
    var row = document.getElementById('dp-tag-sub-input-row');
    if (state.tagSubSelectedIds.size > 0) {
      var inp = document.getElementById('dp-tag-sub-input');
      var prefill = _commonSelectedLabel();
      inp.value = prefill;
      row.style.display = '';
    } else {
      document.getElementById('dp-tag-sub-input').value = '';
      row.style.display = 'none';
    }
    renderOverlays();
  }

  /* ── tagging: sub-word selection helpers ────────────────────── */
  function tagSubWordClick(wordId, shiftKey) {
    if (!state.tagPendingBbox) return;
    var w = wordById[wordId];
    if (!w) return;
    if (w.left < state.tagPendingBbox.left || w.top < state.tagPendingBbox.top ||
        w.left + w.width > state.tagPendingBbox.left + state.tagPendingBbox.width + 4 ||
        w.top + w.height > state.tagPendingBbox.top + state.tagPendingBbox.height + 4) return;
    if (!shiftKey) state.tagSubSelectedIds.clear();
    if (state.tagSubSelectedIds.has(wordId)) state.tagSubSelectedIds.delete(wordId);
    else state.tagSubSelectedIds.add(wordId);
    tagMaybeShowSubInput();
    tagUpdateSubcompDisplay();
  }

  function tagSubSelectInRect(x1, y1, x2, y2, shiftKey) {
    if (!state.tagPendingBbox) return;
    if (!shiftKey) state.tagSubSelectedIds.clear();
    var scale = getScale();
    var px1 = x1/scale, py1 = y1/scale, px2 = x2/scale, py2 = y2/scale;
    var rb = state.tagPendingBbox;
    OCR_WORDS.forEach(function(w){
      // word must overlap the drag rect AND be within the tag region
      if ((w.left+w.width) > px1 && w.left < px2 && (w.top+w.height) > py1 && w.top < py2 &&
          w.left >= rb.left - 4 && w.top >= rb.top - 4 &&
          w.left + w.width <= rb.left + rb.width + 4 &&
          w.top  + w.height <= rb.top  + rb.height + 4) {
        state.tagSubSelectedIds.add(w.id);
      }
    });
    tagMaybeShowSubInput();
    tagUpdateSubcompDisplay();
  }

  /* ── tagging: datalist population ──────────────────────────── */
  function tagPopulateLabelDatalist() {
    var dl = document.getElementById('dp-sub-label-list');
    if (!dl) return;
    var seen = {};
    TAGS.forEach(function(t) {
      (t.subcomponents || []).forEach(function(sc) { if (sc.label) seen[sc.label] = true; });
    });
    state.tagPendingSubcomps.forEach(function(sc) { if (sc.label) seen[sc.label] = true; });
    dl.innerHTML = '';
    Object.keys(seen).sort().forEach(function(lbl) {
      var opt = document.createElement('option'); opt.value = lbl; dl.appendChild(opt);
    });
  }

  /* ── tagging: save / delete ─────────────────────────────────── */
  function tagSave() {
    var label = document.getElementById('dp-tag-label-input').value.trim();
    if (!label) { document.getElementById('dp-tag-label-input').focus(); return; }
    if (!state.tagPendingBbox) return;
    var subcomps = state.tagPendingSubcomps.slice();
    var btn = document.getElementById('dp-tag-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    var body, url;
    if (state.tagEditingId) {
      url = TAG_UPDATE_URL;
      body = 'tag_id=' + state.tagEditingId +
             '&label=' + encodeURIComponent(label) +
             '&bbox_left='   + state.tagPendingBbox.left +
             '&bbox_top='    + state.tagPendingBbox.top  +
             '&bbox_width='  + state.tagPendingBbox.width +
             '&bbox_height=' + state.tagPendingBbox.height +
             '&subcomponents=' + encodeURIComponent(JSON.stringify(subcomps));
    } else {
      url = TAG_CREATE_URL;
      body = 'source_type_id=' + TAG_SOURCE_TYPE_ID +
             '&source_id='     + TAG_SOURCE_ID +
             '&label='         + encodeURIComponent(label) +
             '&bbox_left='     + state.tagPendingBbox.left +
             '&bbox_top='      + state.tagPendingBbox.top  +
             '&bbox_width='    + state.tagPendingBbox.width +
             '&bbox_height='   + state.tagPendingBbox.height +
             '&subcomponents=' + encodeURIComponent(JSON.stringify(subcomps));
    }
    fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN}, body: body })
    .then(function(r){ return r.json(); })
    .then(function(data){
      btn.disabled = false; btn.textContent = 'Save ↵';
      if (!data.ok) { alert(data.error || 'Error saving tag.'); return; }
      if (state.tagEditingId) {
        var idx = TAGS.findIndex(function(t){ return t.id === state.tagEditingId; });
        if (idx >= 0) TAGS[idx] = data.tag;
      } else {
        TAGS.push(data.tag);
        adjustDocTagCount(1);
      }
      tagPopulateLabelDatalist();
      tagExitLabelingMode();
    })
    .catch(function(){ btn.disabled = false; btn.textContent = 'Save ↵'; });
  }

  function tagDelete() {
    if (!state.tagEditingId) return;
    if (!confirm('Delete this tag?')) return;
    fetch(TAG_DELETE_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN}, body: 'tag_id=' + state.tagEditingId })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!data.ok) { alert('Error deleting tag.'); return; }
      var id = state.tagEditingId;
      TAGS = TAGS.filter(function(t){ return t.id !== id; });
      adjustDocTagCount(-1);
      tagExitLabelingMode();
    });
  }

  function adjustDocTagCount(delta) {
    var el = document.getElementById('dp-doc-tag-count-val');
    if (!el) return;
    var n = (parseInt(el.textContent, 10) || 0) + delta;
    el.textContent = n;
    var suffix = document.getElementById('dp-doc-tag-count-suffix');
    if (suffix) suffix.textContent = 'tag' + (n === 1 ? '' : 's');
  }

  /* ── NER entity type helpers ───────────────────────────────── */
  var NER_ENTITY_LABEL = { PER: 'name', LOC: 'address', ORG: 'organization' };

  function nerEffectiveLabel(w) {
    var raw = w.corrected_ner_label || w.ner_label;
    if (!raw) return null;
    return raw; // full BIO label e.g. "B-PER"
  }

  function nerEntityType(w) {
    var lbl = nerEffectiveLabel(w);
    if (!lbl) return null;
    return lbl.replace(/^[BI]-/, ''); // "PER", "LOC", "ORG"
  }

  /* ── NER repair popup ──────────────────────────────────────── */

  function nerOpenPopup(wordId, clientX, clientY) {
    state.nerPopupWordId = wordId;
    var w = wordById[wordId];
    if (!w) return;
    var popup = document.getElementById('dp-ner-popup');
    document.getElementById('dp-ner-word-text').textContent = w.corrected_text || w.text;
    document.getElementById('dp-ner-label-select').value = nerEffectiveLabel(w) || '';
    popup.style.left = clientX + 'px';
    popup.style.top  = clientY + 'px';
    popup.style.display = 'block';
  }

  function nerClosePopup() {
    document.getElementById('dp-ner-popup').style.display = 'none';
    state.nerPopupWordId = null;
  }

  document.addEventListener('click', function(e) {
    var popup = document.getElementById('dp-ner-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) nerClosePopup();
  });

  // Prevent clicks/mousedowns inside the popup from falling through to the viewer canvas
  var _nerPopup = document.getElementById('dp-ner-popup');
  _nerPopup.addEventListener('mousedown', function(e) { e.stopPropagation(); });
  _nerPopup.addEventListener('click',     function(e) { e.stopPropagation(); });

  document.getElementById('dp-ner-cancel-btn').addEventListener('click', nerClosePopup);
  document.getElementById('dp-ner-save-btn').addEventListener('click', function(e) {
    if (state.nerPopupWordId == null) return;
    var label = document.getElementById('dp-ner-label-select').value;
    if (!label) {label = "NONE"}
    fetch(NER_CORRECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN },
      body: 'word_id=' + state.nerPopupWordId + '&label=' + encodeURIComponent(label)
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!data.ok) { alert(data.error || 'Error saving NER label.'); return; }
      var w = wordById[state.nerPopupWordId];
      if (w) { w.corrected_ner_label = label || null; }
      nerClosePopup();
      renderOverlays();
    });
  });

  /* ── NER suggestions when entering labeling mode ───────────── */
  function nerSuggestSubcomps(bbox) {
    if (!bbox) return;
    OCR_WORDS.forEach(function(w) {
      var entityType = nerEntityType(w);
      if (!entityType) return;
      var inRegion = w.left >= bbox.left - 4 && w.top >= bbox.top - 4 &&
                     w.left + w.width  <= bbox.left + bbox.width  + 4 &&
                     w.top  + w.height <= bbox.top  + bbox.height + 4;
      if (!inRegion) return;
      var suggLabel = NER_ENTITY_LABEL[entityType] || entityType.toLowerCase();
      var existing = state.tagPendingSubcomps.find(function(s){ return s.word_id === w.id; });
      if (!existing) {
        var text = (w.corrected_text != null ? w.corrected_text : w.text) || '';
        state.tagPendingSubcomps.push({ word_id: w.id, label: suggLabel, text: text });
      }
    });
    tagUpdateSubcompDisplay();
  }

  /* ── overlay rendering ─────────────────────────────────────── */
  function renderOverlays() {
    var viewer = document.getElementById('dp-viewer'), img = document.getElementById('dp-img');
    if (!viewer || !img || !img.naturalWidth) return;
    viewer.querySelectorAll('.dp-word-ghost, .ocr-word, .dp-tag-overlay, .dp-ner-overlay').forEach(function (el) { el.remove(); });
    var scale = getScale();

    if (state.activeTab === 'tagging') {
      // NER entity overlays (drawn beneath word ghosts; hidden in labeling mode)
      if (state.tagPhase === 'draw') {
        OCR_WORDS.forEach(function(w) {
          var entityType = nerEntityType(w);
          var className = "dp-ner-overlay";
          if (!entityType) {
            className += " ner-NONE"
          } else {
            className += " ner-" + entityType;
          }
          var div = document.createElement('div');
          div.className = className;
          div.dataset.wordId = w.id;
          div.style.left   = Math.round(w.left   * scale) + 'px';
          div.style.top    = Math.round(w.top    * scale) + 'px';
          div.style.width  = Math.round(w.width  * scale) + 'px';
          div.style.height = Math.round(w.height * scale) + 'px';
          div.title = (nerEffectiveLabel(w) || '') + ': ' + (w.corrected_text || w.text);
          div.addEventListener('mousedown', function(e) { e.stopPropagation(); });
          div.addEventListener('click', function(e) {
            e.stopPropagation();
            nerOpenPopup(w.id, e.clientX + 8, e.clientY + 8);
          });
          viewer.appendChild(div);
        });
      }

      // Ghost word boxes — only in labeling mode (draw mode uses NER overlays instead)
      var taggedIds = new Set(state.tagPendingSubcomps.map(function(s){ return s.word_id; }));
      if (state.tagPhase === 'labeling') OCR_WORDS.forEach(function (w) {
        if (state.tagPendingBbox) {
          var rb = state.tagPendingBbox;
          var inRegion = w.left >= rb.left - 4 && w.top >= rb.top - 4 &&
                         w.left + w.width  <= rb.left + rb.width  + 4 &&
                         w.top  + w.height <= rb.top  + rb.height + 4;
          if (!inRegion) return;
        }
        var div = document.createElement('div');
        var cls = 'dp-word-ghost';
        if (state.tagSubSelectedIds.has(w.id))  cls += ' sub-selected';
        else if (taggedIds.has(w.id))     cls += ' sub-tagged';
        div.className = cls;
        div.dataset.wordId = w.id;
        div.style.left   = Math.round(w.left   * scale) + 'px';
        div.style.top    = Math.round(w.top    * scale) + 'px';
        div.style.width  = Math.round(w.width  * scale) + 'px';
        div.style.height = Math.round(w.height * scale) + 'px';
        div.title = w.corrected_text || w.text;
        viewer.appendChild(div);
      });

      // Tag overlays (idle mode only — in labeling mode just the active rect)
      if (state.tagPhase === 'draw') tagRenderTagOverlays();

    } else {
      // OCR tab
      OCR_WORDS.forEach(function (w) {
        var div = document.createElement('div');
        if (HAS_REPAIR && w.id != null) {
          div.className = wordClass(w) + (state.ocrSelectedIds.has(w.id) ? ' selected' : '');
          div.dataset.wordId = w.id;
        } else {
          div.className = 'ocr-word ' + (w.is_ditto ? 'conf-ditto' : w.conf < 60 ? 'conf-low' : w.conf < 80 ? 'conf-mid' : 'conf-high');
        }
        div.style.left   = Math.round(w.left   * scale) + 'px';
        div.style.top    = Math.round(w.top    * scale) + 'px';
        div.style.width  = Math.round(w.width  * scale) + 'px';
        div.style.height = Math.round(w.height * scale) + 'px';
        div.title = (w.corrected_text ? '✓ ' + w.corrected_text : w.text) + ' (' + Math.round(w.conf) + '%)';
        viewer.appendChild(div);
      });
    }
  }

  /* ── full-text panel (OCR tab) ────────────────────────────── */
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function _buildLineMap() {
    var lineMap = {};
    OCR_WORDS.forEach(function (w) {
      if (w.block_num == null) return;
      var key = w.block_num + '\x00' + w.par_num + '\x00' + w.line_num;
      if (!lineMap[key]) lineMap[key] = { b: w.block_num, p: w.par_num, l: w.line_num, words: [] };
      lineMap[key].words.push(w);
    });
    var lines = Object.values(lineMap);
    lines.sort(function (a,b) { return a.b!==b.b?a.b-b.b:a.p!==b.p?a.p-b.p:a.l-b.l; });
    lines.forEach(function(line){ line.words.sort(function(a,b){return a.word_num-b.word_num;}); });
    return lines;
  }

  function buildFullText() {
    if (!OCR_WORDS.length) return '';
    var lines = _buildLineMap(), out = [], prevB = null, prevP = null;
    lines.forEach(function (line) {
      if (prevB !== null && line.b !== prevB) out.push('');
      else if (prevP !== null && line.p !== prevP) out.push('');
      prevB = line.b; prevP = line.p;
      out.push(line.words.filter(function(w){return(w.corrected_text||w.text||'').trim();})
        .map(function(w){return w.corrected_text!=null?w.corrected_text:w.text;}).join(' '));
    });
    return out.join('\n');
  }

  function updateTextPanels() {
    var ocr = document.getElementById('dp-corrected-text');
    if (ocr) ocr.textContent = buildFullText();
  }

  /* ── rank / role extraction ────────────────────────────────── */
  var RANKS = [
    'Imperial Grand Wizard',
    'Imperial Wizard','Grand Wizard','Grand Dragon','Grand Titan','Grand Hydra',
    'Grand Cyclops','Grand Kleagle','King Kleagle','Imperial Kleagle',
    'Exalted Cyclops','Night Hawk',
    'Nighthawk','Kleagle','Cyclops','Klaliff','Kligrapp','Klabee',
    'Kladd','Klarogo','Klexter','Titan','Hydra','Fury',
    'Chief Warrant Officer','Warrant Officer',
    'Brigadier General','Major General','Lieutenant General',
    'Lieutenant Colonel','First Lieutenant','Second Lieutenant',
    'First Sergeant','Master Sergeant','Technical Sergeant','Staff Sergeant',
    'Sergeant Major','Private First Class',
    'General','Colonel','Major','Captain','Lieutenant',
    'Sergeant','Corporal','Private','Admiral','Commander','Ensign',
    'Gen','Col','Maj','Capt','Lt','Sgt','Cpl','Pvt','Adm','Cmdr','PFC',
    'Reverend','Doctor','Professor','Rev','Dr','Prof',
  ];

  function extractRank(tokens) {
    var norm = tokens.map(function(t){ return t.replace(/[.,]/g,'').toLowerCase(); });
    for (var ri = 0; ri < RANKS.length; ri++) {
      var rParts = RANKS[ri].toLowerCase().split(' '), rLen = rParts.length;
      for (var i = 0; i <= norm.length - rLen; i++) {
        var match = true;
        for (var j = 0; j < rLen; j++) { if (norm[i+j] !== rParts[j]) { match = false; break; } }
        if (match) return { rank: RANKS[ri], remaining: tokens.slice(0,i).concat(tokens.slice(i+rLen)) };
      }
    }
    return { rank: '', remaining: tokens };
  }

  /* ── person modal ──────────────────────────────────────────── */

  function openPersonModal() {
    if (!HAS_REPAIR) return;
    var words = state.ocrSelectedIds.size ? OCR_WORDS.filter(function (w) { return state.ocrSelectedIds.has(w.id); }) : [];
    var parsed = parseNameFromWords(words);
    document.getElementById('dpp-first').value  = parsed.first;
    document.getElementById('dpp-middle').value = parsed.middle;
    document.getElementById('dpp-last').value   = parsed.last;
    document.getElementById('dpp-role').value   = parsed.role || '';
    var msg = document.getElementById('dp-person-msg'); msg.style.display = 'none'; msg.textContent = '';
    var backdrop = document.getElementById('dp-person-backdrop');
    backdrop.classList.add('open');
    document.getElementById('dpp-first').focus();
    if (!state.personGroupsLoaded) {
      fetch(CREATE_PERSON_URL, { headers: { 'X-CSRFToken': CSRF_TOKEN } })
        .then(function(r){return r.json();}).then(function(data){
          if (!data.ok) return;
          var sel = document.getElementById('dpp-group'); sel.innerHTML = '';
          data.groups.forEach(function(g){var o=document.createElement('option');o.value=g.id;o.textContent=g.name;sel.appendChild(o);});
          state.personGroupsLoaded = true;
        });
    }
  }
  function closePersonModal() { document.getElementById('dp-person-backdrop').classList.remove('open'); }

  function parseNameFromWords(words) {
    words = words.slice().sort(function(a,b){return a.block_num!==b.block_num?a.block_num-b.block_num:a.par_num!==b.par_num?a.par_num-b.par_num:a.line_num!==b.line_num?a.line_num-b.line_num:a.word_num-b.word_num;});
    var allTokens = words.map(function(w){return(w.corrected_text!=null?w.corrected_text:w.text).trim();}).filter(Boolean);
    var extracted = extractRank(allTokens);
    var tokens = extracted.remaining;
    function sc(s){return s.replace(/,/g,'');}
    var first='',middle='',last='';
    if (tokens.length===1) { last=tokens[0]; }
    else if (tokens.length===2) { if(tokens[0].slice(-1)===','){last=tokens[0];first=tokens[1];}else{first=tokens[0];last=tokens[1];} }
    else if (tokens.length>=3) { if(tokens[0].slice(-1)===','){last=tokens[0];first=tokens[1];middle=tokens.slice(2).join(' ');}else{first=tokens[0];middle=tokens.slice(1,-1).join(' ');last=tokens[tokens.length-1];} }
    return { first: sc(first), middle: sc(middle), last: sc(last), role: extracted.rank };
  }

  function savePersonModal() {
    if (!HAS_REPAIR) return;
    var last = document.getElementById('dpp-last').value.trim();
    if (!last) { document.getElementById('dpp-last').focus(); return; }
    var saveBtn = document.getElementById('dpp-save'); saveBtn.disabled = true;
    var words = state.ocrSelectedIds.size ? OCR_WORDS.filter(function(w){return state.ocrSelectedIds.has(w.id);}) : [];
    var bbox = null;
    if (words.length) {
      var l=Math.min.apply(null,words.map(function(w){return w.left;}));
      var t=Math.min.apply(null,words.map(function(w){return w.top;}));
      var r=Math.max.apply(null,words.map(function(w){return w.left+w.width;}));
      var b=Math.max.apply(null,words.map(function(w){return w.top+w.height;}));
      bbox = {left:l,top:t,width:r-l,height:b-t};
    }
    var body = 'last_name='   + encodeURIComponent(last) +
               '&first_name=' + encodeURIComponent(document.getElementById('dpp-first').value.trim()) +
               '&middle_name='+ encodeURIComponent(document.getElementById('dpp-middle').value.trim()) +
               '&role='       + encodeURIComponent(document.getElementById('dpp-role').value.trim()) +
               '&group_pk='   + encodeURIComponent(document.getElementById('dpp-group').value) +
               (bbox ? '&bbox_left='+bbox.left+'&bbox_top='+bbox.top+'&bbox_width='+bbox.width+'&bbox_height='+bbox.height : '');
    fetch(CREATE_PERSON_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN}, body: body })
    .then(function(r){return r.json();}).then(function(data){
      saveBtn.disabled = false;
      if (!data.ok) {
        var msg=document.getElementById('dp-person-msg'); msg.style.color='#a00'; msg.textContent=data.error||'Error.'; msg.style.display='block'; return;
      }
      closePersonModal();
      var strip=document.getElementById('dp-person-confirm-strip');
      strip.innerHTML='Membership created: <a href="'+data.individual.url+'" target="_blank">'+data.individual.str+'</a> &nbsp;·&nbsp; <a href="'+data.membership.url+'" target="_blank">View membership</a> &nbsp;<button onclick="this.parentNode.style.display=\'none\'" style="float:right;cursor:pointer">✕</button>';
      strip.style.display='block';
      clearOcrSelection();
      renderOverlays(); updateBadge();
    }).catch(function(){saveBtn.disabled=false;});
  }

  /* ── word class helper ─────────────────────────────────────── */
  function wordClass(w) {
    if (w.corrected_text) return 'ocr-word ' + (w.is_ditto ? 'conf-ditto' : 'corrected');
    return 'ocr-word ' + (w.conf < 60 ? 'conf-low' : w.conf < 80 ? 'conf-mid' : 'conf-high');
  }

  /* ── OCR repair selection + mouse handling ─────────────────── */

  function clearOcrSelection() {
    if (!HAS_REPAIR) return;
    state.ocrSelectedIds.clear();
    document.querySelectorAll('.ocr-word.selected').forEach(function(el){el.classList.remove('selected');});
    updateOcrMergeBar();
  }

  function updateOcrMergeBar() {
    var bar=document.getElementById('ocr-merge-bar');
    if (!bar) return;   // merge/bulk UI is not present in this build
    var n=state.ocrSelectedIds.size;
    if (n<2){bar.style.display='none';return;}
    document.getElementById('ocr-merge-label').textContent=n+' words selected';
    var sel=OCR_WORDS.filter(function(w){return state.ocrSelectedIds.has(w.id);});
    sel.sort(function(a,b){return a.block_num!==b.block_num?a.block_num-b.block_num:a.par_num!==b.par_num?a.par_num-b.par_num:a.line_num!==b.line_num?a.line_num-b.line_num:a.word_num-b.word_num;});
    var input=document.getElementById('ocr-merge-input'); input.value=sel.map(function(w){return w.corrected_text||w.text;}).join(' ');
    bar.style.display='flex'; input.focus(); input.select();
  }

  function ocrSelectInRect(x1,y1,x2,y2) {
    var s=getScale(), px1=x1/s, py1=y1/s, px2=x2/s, py2=y2/s;
    state.ocrSelectedIds.clear();
    OCR_WORDS.forEach(function(w){if((w.left+w.width)>px1&&w.left<px2&&(w.top+w.height)>py1&&w.top<py2)state.ocrSelectedIds.add(w.id);});
    document.querySelectorAll('.ocr-word').forEach(function(el){el.classList.toggle('selected',state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));});
    updateOcrMergeBar();
  }

  function recordUndo(e){state.undoStack.push(e);state.redoStack=[];}

  function _deleteWordById(id,cb){
    fetch(DELETE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'word_pk='+encodeURIComponent(id)})
    .then(function(r){return r.json();}).then(function(data){if(!data.ok)return;OCR_WORDS=OCR_WORDS.filter(function(w){return w.id!==data.deleted_id;});delete wordById[data.deleted_id];var el=document.querySelector("[data-word-id='"+data.deleted_id+"']");if(el)el.remove();updateTextPanels();if(cb)cb();});
  }
  function _addWordFromData(w,cb){
    fetch(ADD_WORD_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'left='+w.left+'&top='+w.top+'&width='+w.width+'&height='+w.height+'&corrected_text='+encodeURIComponent(w.corrected_text||w.text||'')})
    .then(function(r){return r.json();}).then(function(data){if(!data.ok)return;OCR_WORDS.push(data.word);wordById[data.word.id]=data.word;renderOverlays();updateTextPanels();if(cb)cb(data.word);});
  }
  function _applyHistory(from,to){
    if(!from.length)return;var e=from.pop();
    if(e.type==='correct'){var w=wordById[e.wordId];if(!w)return;var el=document.querySelector("[data-word-id='"+e.wordId+"']");to.push({type:'correct',wordId:e.wordId,prev:e.next,next:e.prev});postCorrection(w,el,e.prev,true);}
    else if(e.type==='add'){var s=Object.assign({},wordById[e.wordId]);to.push({type:'delete',wordData:s});_deleteWordById(e.wordId);}
    else if(e.type==='delete'){_addWordFromData(e.wordData,function(nw){to.push({type:'add',wordId:nw.id});});}
  }
  function undo(){_applyHistory(state.undoStack,state.redoStack);} function redo(){_applyHistory(state.redoStack,state.undoStack);}

  function openEditPopup(word,el,event){
    if (!HAS_REPAIR) return;
    var popup=document.getElementById('ocr-popup');
    var mergeBar=document.getElementById('ocr-merge-bar'); if (mergeBar) mergeBar.style.display='none';
    state.currentWord=word;state.currentEl=el;
    document.getElementById('ocr-popup-original').textContent='Original: '+word.text;
    document.getElementById('ocr-popup-input').value=word.corrected_text||'';
    var x=event.clientX+10,y=event.clientY+10;if(x+240>window.innerWidth-16)x=window.innerWidth-256;
    popup.style.left=x+'px';popup.style.top=y+'px';popup.style.display='block';
    var confirmBtn=document.getElementById('ocr-popup-confirm'); if (confirmBtn) confirmBtn.style.display='';
    var delBtn=document.getElementById('ocr-popup-delete'); if (delBtn) delBtn.style.display='';
    var dittoBtn=document.getElementById('ocr-popup-ditto'); if (dittoBtn) dittoBtn.style.display='';
    document.getElementById('ocr-popup-input').focus();document.getElementById('ocr-popup-input').select();
  }
  function closeEditPopup(){var popup=document.getElementById('ocr-popup');popup.style.display='none';popup._pendingRegion=null;state.currentWord=null;state.currentEl=null;if(state.ocrSelectedIds.size>=2)updateOcrMergeBar();}
  function postCorrection(word,el,text,skipUndo){
    if (!HAS_REPAIR) return;
    var prev=word.corrected_text;if(!skipUndo)recordUndo({type:'correct',wordId:word.id,prev:prev,next:text});
    fetch(CORRECT_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'word_pk='+encodeURIComponent(word.id)+'&corrected_text='+encodeURIComponent(text)})
    .then(function(r){return r.json();}).then(function(data){if(!data.ok)return;word.corrected_text=data.corrected_text||null;if(el){el.className=wordClass(word)+(state.ocrSelectedIds.has(word.id)?' selected':'');el.title=(word.corrected_text?'✓ '+word.corrected_text:word.text)+' ('+Math.round(word.conf)+'%)';}updateTextPanels();});
  }
  function saveEdit(){var input=document.getElementById('ocr-popup-input'),popup=document.getElementById('ocr-popup'),pending=popup._pendingRegion;if(pending){var t=input.value.trim();popup._pendingRegion=null;closeEditPopup();setDrawMode(false);if(t)saveAddRegion(pending,t);else document.getElementById('dp-draw-rect').style.display='none';return;}if(!state.currentWord)return;postCorrection(state.currentWord,state.currentEl,input.value.trim());closeEditPopup();}
  function confirmEdit(){if(!state.currentWord)return;postCorrection(state.currentWord,state.currentEl,state.currentWord.text);closeEditPopup();}
  function deleteWord(){if(!state.currentWord)return;var snap=Object.assign({},state.currentWord),id=state.currentWord.id;closeEditPopup();_deleteWordById(id,function(){recordUndo({type:'delete',wordData:snap});});}
  function _applyDittoResult(word, el, data) {
    word.text = '"'; word.corrected_text = null; word.is_ditto = false;
    if (el) {
      el.className = wordClass(word) + (state.ocrSelectedIds.has(word.id) ? ' selected' : '');
      el.title = word.text + ' (' + Math.round(word.conf) + '%)';
    }
    data.updated.forEach(function(u) {
      var w = wordById[u.id];
      if (w) {
        w.corrected_text = u.corrected_text;
        w.is_ditto = true;
        var e = document.querySelector('[data-word-id="' + u.id + '"]');
        if (e) {
          e.className = wordClass(w) + (state.ocrSelectedIds.has(w.id) ? ' selected' : '');
          e.title = '✓ ' + u.corrected_text + ' (' + Math.round(w.conf) + '%)';
        }
      }
    });
    renderOverlays();
    updateTextPanels();
  }
  function markWordAsDitto() {
    if (!MARK_AS_DITTO_URL) return;
    var popup = document.getElementById('ocr-popup');
    var pending = popup._pendingRegion;
    if (pending) {
      popup._pendingRegion = null;
      closeEditPopup();
      setDrawMode(false);
      fetch(ADD_WORD_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
        body: 'left=' + pending.left + '&top=' + pending.top + '&width=' + pending.width + '&height=' + pending.height + '&corrected_text='
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) return;
        var word = data.word;
        OCR_WORDS.push(word); wordById[word.id] = word;
        recordUndo({type: 'add', wordId: word.id});
        renderOverlays();
        fetch(MARK_AS_DITTO_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
          body: 'word_pk=' + encodeURIComponent(word.id)
        }).then(function(r) { return r.json(); }).then(function(data2) {
          if (!data2.ok) return;
          var el = document.querySelector('[data-word-id="' + word.id + '"]');
          _applyDittoResult(word, el, data2);
        });
      });
      return;
    }
    if (!state.currentWord) return;
    var word = state.currentWord, el = state.currentEl;
    closeEditPopup();
    fetch(MARK_AS_DITTO_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: 'word_pk=' + encodeURIComponent(word.id)
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (!data.ok) return;
      _applyDittoResult(word, el, data);
    });
  }
  function reorderLine(dir){if(!state.ocrSelectedIds.size)return;fetch(REORDER_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'word_pks='+encodeURIComponent(Array.from(state.ocrSelectedIds).join(','))+'&direction='+dir}).then(function(r){return r.json();}).then(function(data){if(!data.ok)return;data.updated.forEach(function(w){var ex=wordById[w.id];if(ex)Object.assign(ex,w);});updateTextPanels();});}
  function joinLine(){if(state.ocrSelectedIds.size<2)return;fetch(JOIN_LINE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'word_pks='+encodeURIComponent(Array.from(state.ocrSelectedIds).join(','))}).then(function(r){return r.json();}).then(function(data){if(!data.ok)return;data.updated.forEach(function(w){var ex=wordById[w.id];if(ex)Object.assign(ex,w);});state.ocrSelectedIds.clear();document.getElementById('ocr-merge-bar').style.display='none';updateTextPanels();});}
  function confirmAll(){var btn=document.getElementById('dp-confirm-all');btn.disabled=true;btn.textContent='Confirming…';fetch(CONFIRM_ALL_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''}).then(function(r){return r.json();}).then(function(data){if(!data.ok){btn.disabled=false;btn.textContent='Confirm all';return;}data.updated.forEach(function(u){var w=wordById[u.id];if(w)w.corrected_text=u.corrected_text;});renderOverlays();updateTextPanels();btn.textContent='Confirmed ('+data.updated.length+')';setTimeout(function(){btn.disabled=false;btn.textContent='Confirm all';},2000);}).catch(function(){btn.disabled=false;btn.textContent='Confirm all';});}
  function saveMerge(){if(state.ocrSelectedIds.size<2)return;fetch(MERGE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'word_pks='+encodeURIComponent(Array.from(state.ocrSelectedIds).join(','))+'&corrected_text='+encodeURIComponent(document.getElementById('ocr-merge-input').value.trim())}).then(function(r){return r.json();}).then(function(data){if(!data.ok)return;var del=new Set(data.deleted_ids);OCR_WORDS=OCR_WORDS.filter(function(w){return!del.has(w.id);});data.deleted_ids.forEach(function(id){delete wordById[id];});var mw=data.merged_word,keeper=wordById[mw.id];if(keeper)Object.assign(keeper,mw);state.ocrSelectedIds.clear();renderOverlays();updateTextPanels();document.getElementById('ocr-merge-bar').style.display='none';});}
  function bulkDitto() {
    if (!state.ocrSelectedIds.size || !BULK_DITTO_URL) return;
    var pks = Array.from(state.ocrSelectedIds);
    fetch(BULK_DITTO_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: 'word_pks=' + encodeURIComponent(pks.join(','))
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (!data.ok) return;
      data.marked_pks.forEach(function(id) {
        var w = wordById[id];
        if (w) { w.text = '"'; w.corrected_text = null; w.is_ditto = false; }
      });
      data.updated.forEach(function(u) {
        var w = wordById[u.id];
        if (w) { w.corrected_text = u.corrected_text; w.is_ditto = true; }
      });
      state.ocrSelectedIds.clear();
      document.getElementById('ocr-merge-bar').style.display = 'none';
      renderOverlays();
      updateTextPanels();
    });
  }
  function bulkDelete() {
    if (!state.ocrSelectedIds.size || !BULK_DELETE_URL) return;
    var pks = Array.from(state.ocrSelectedIds);
    if (!confirm('Delete ' + pks.length + ' selected word' + (pks.length === 1 ? '' : 's') + '?')) return;
    fetch(BULK_DELETE_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: 'word_pks=' + encodeURIComponent(pks.join(','))
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (!data.ok) return;
      var del = new Set(data.deleted_ids);
      OCR_WORDS = OCR_WORDS.filter(function(w) { return !del.has(w.id); });
      data.deleted_ids.forEach(function(id) { delete wordById[id]; });
      state.ocrSelectedIds.clear();
      document.getElementById('ocr-merge-bar').style.display = 'none';
      renderOverlays();
      updateTextPanels();
    });
  }

  function toggleBoxes(){state.boxesHidden=!state.boxesHidden;document.getElementById('dp-viewer').classList.toggle('hide-boxes',state.boxesHidden);document.getElementById('dp-boxes-toggle').textContent=state.boxesHidden?'Show boxes':'Hide boxes';}

  function viewerOffset(e){var r=document.getElementById('dp-viewer').getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  function setDrawMode(active){state.drawMode=active;var v=document.getElementById('dp-viewer'),btn=document.getElementById('dp-draw-toggle');if(active){v.classList.add('draw-mode');btn.textContent='Cancel draw';btn.style.background='#e67e00';btn.style.color='#fff';}else{v.classList.remove('draw-mode');btn.textContent='Add region (a)';btn.style.background='';btn.style.color='';document.getElementById('dp-draw-rect').style.display='none';state.drawOrigin=null;}}
  function saveAddRegion(pending,text){fetch(ADD_WORD_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'left='+pending.left+'&top='+pending.top+'&width='+pending.width+'&height='+pending.height+'&corrected_text='+encodeURIComponent(text)}).then(function(r){return r.json();}).then(function(data){if(!data.ok)return;OCR_WORDS.push(data.word);wordById[data.word.id]=data.word;recordUndo({type:'add',wordId:data.word.id});renderOverlays();updateTextPanels();document.getElementById('dp-draw-rect').style.display='none';});}

  /* ── unified mouse handling ────────────────────────────────── */
  function onViewerMousedown(e) {
    if (state.activeTab === 'tagging') {
      if (state.tagPhase === 'draw') {
        e.preventDefault();
        state.tagDrawStart = { x: e.clientX, y: e.clientY };
        state.isDragging = false;
      } else if (state.tagPhase === 'labeling') {
        var ghostEl = e.target.closest ? e.target.closest('.dp-word-ghost') : null;
        if (!ghostEl) {
          e.preventDefault();
          state.tagSubDrawStart = { x: e.clientX, y: e.clientY };
          state.isDragging = false;
        }
      }
    } else if (state.activeTab === 'ocr') {
      if (state.drawMode) {
        e.preventDefault(); state.drawOrigin = viewerOffset(e);
        var dr=document.getElementById('dp-draw-rect'); dr.style.left=state.drawOrigin.x+'px';dr.style.top=state.drawOrigin.y+'px';dr.style.width='0';dr.style.height='0';dr.style.display='block';
      } else {
        e.preventDefault(); state.selectStart={x:e.clientX,y:e.clientY,target:e.target}; state.isDragging=false;
      }
    }
  }

  function onDocMousemove(e) {
    if (state.activeTab === 'tagging') {
      if (state.tagResizing) {
        var scale = getScale();
        var dx = (e.clientX - state.tagResizing.startX) / scale;
        var dy = (e.clientY - state.tagResizing.startY) / scale;
        var b  = state.tagResizing.startBbox;
        var nb = { left: b.left, top: b.top, width: b.width, height: b.height };
        var MIN = 10;
        switch (state.tagResizing.corner) {
          case 'tl':
            nb.left  = Math.round(b.left + dx); nb.top = Math.round(b.top + dy);
            nb.width  = Math.max(MIN, Math.round(b.width  - dx));
            nb.height = Math.max(MIN, Math.round(b.height - dy));
            if (nb.width  === MIN) nb.left  = b.left + b.width  - MIN;
            if (nb.height === MIN) nb.top   = b.top  + b.height - MIN;
            break;
          case 'tr':
            nb.top    = Math.round(b.top + dy);
            nb.width  = Math.max(MIN, Math.round(b.width  + dx));
            nb.height = Math.max(MIN, Math.round(b.height - dy));
            if (nb.height === MIN) nb.top = b.top + b.height - MIN;
            break;
          case 'bl':
            nb.left   = Math.round(b.left + dx);
            nb.width  = Math.max(MIN, Math.round(b.width  - dx));
            nb.height = Math.max(MIN, Math.round(b.height + dy));
            if (nb.width === MIN) nb.left = b.left + b.width - MIN;
            break;
          case 'br':
            nb.width  = Math.max(MIN, Math.round(b.width  + dx));
            nb.height = Math.max(MIN, Math.round(b.height + dy));
            break;
        }
        state.tagPendingBbox = nb;
        tagUpdateVeils();
        renderOverlays();
        return;
      }
      if (state.tagPhase === 'draw' && state.tagDrawStart) {
        var dx=e.clientX-state.tagDrawStart.x, dy=e.clientY-state.tagDrawStart.y;
        if (!state.isDragging && Math.sqrt(dx*dx+dy*dy) > 5) state.isDragging = true;
        if (state.isDragging) {
          var vr=document.getElementById('dp-viewer').getBoundingClientRect();
          var dr=document.getElementById('dp-tag-draw-rect');
          dr.style.left  =Math.min(state.tagDrawStart.x,e.clientX)-vr.left+'px';
          dr.style.top   =Math.min(state.tagDrawStart.y,e.clientY)-vr.top+'px';
          dr.style.width =Math.abs(e.clientX-state.tagDrawStart.x)+'px';
          dr.style.height=Math.abs(e.clientY-state.tagDrawStart.y)+'px';
          dr.style.display='block';
        }
      } else if (state.tagPhase === 'labeling' && state.tagSubDrawStart) {
        var dx2=e.clientX-state.tagSubDrawStart.x, dy2=e.clientY-state.tagSubDrawStart.y;
        if (!state.isDragging && Math.sqrt(dx2*dx2+dy2*dy2) > 5) state.isDragging = true;
        if (state.isDragging) {
          var vr2=document.getElementById('dp-viewer').getBoundingClientRect();
          var sr=document.getElementById('dp-tag-sub-rect');
          sr.style.left  =Math.min(state.tagSubDrawStart.x,e.clientX)-vr2.left+'px';
          sr.style.top   =Math.min(state.tagSubDrawStart.y,e.clientY)-vr2.top+'px';
          sr.style.width =Math.abs(e.clientX-state.tagSubDrawStart.x)+'px';
          sr.style.height=Math.abs(e.clientY-state.tagSubDrawStart.y)+'px';
          sr.style.display='block';
        }
      }
    } else if (state.activeTab === 'ocr') {
      if (state.drawMode) {
        if (!state.drawOrigin) return; var pos=viewerOffset(e),dr=document.getElementById('dp-draw-rect');
        dr.style.left=Math.min(pos.x,state.drawOrigin.x)+'px';dr.style.top=Math.min(pos.y,state.drawOrigin.y)+'px';dr.style.width=Math.abs(pos.x-state.drawOrigin.x)+'px';dr.style.height=Math.abs(pos.y-state.drawOrigin.y)+'px';
      } else {
        if (!state.selectStart) return;
        var dx3=e.clientX-state.selectStart.x,dy3=e.clientY-state.selectStart.y;
        if (!state.isDragging&&Math.sqrt(dx3*dx3+dy3*dy3)>5){state.isDragging=true;clearOcrSelection();}
        if (state.isDragging){var vr3=document.getElementById('dp-viewer').getBoundingClientRect(),sr3=document.getElementById('dp-select-rect');sr3.style.left=Math.min(state.selectStart.x,e.clientX)-vr3.left+'px';sr3.style.top=Math.min(state.selectStart.y,e.clientY)-vr3.top+'px';sr3.style.width=Math.abs(e.clientX-state.selectStart.x)+'px';sr3.style.height=Math.abs(e.clientY-state.selectStart.y)+'px';sr3.style.display='block';}
      }
    }
  }

  function onDocMouseup(e) {
    if (state.activeTab === 'tagging') {
      if (state.tagResizing) { state.tagResizing = null; return; }
      if (state.tagPhase === 'draw') {
        document.getElementById('dp-tag-draw-rect').style.display = 'none';
        if (state.isDragging && state.tagDrawStart) {
          var vr=document.getElementById('dp-viewer').getBoundingClientRect();
          var scale=getScale();
          var px=Math.min(state.tagDrawStart.x,e.clientX)-vr.left, py=Math.min(state.tagDrawStart.y,e.clientY)-vr.top;
          var pw=Math.abs(e.clientX-state.tagDrawStart.x), ph=Math.abs(e.clientY-state.tagDrawStart.y);
          pw = Math.max(0, pw - Math.max(0, -px)); ph = Math.max(0, ph - Math.max(0, -py));
          px = Math.max(0, px); py = Math.max(0, py);
          if (pw > 4 && ph > 4) {
            state.tagPendingBbox = { left: Math.round(px/scale), top: Math.round(py/scale), width: Math.round(pw/scale), height: Math.round(ph/scale) };
            state.tagPendingLabel = ''; state.tagPendingSubcomps = []; state.tagEditingId = null;
            tagEnterLabelingMode();
          }
        } else if (!state.isDragging) {
          // Simple click (no drag) — NER overlay takes priority, then existing tag
          var nerEl = e.target.closest ? e.target.closest('.dp-ner-overlay') : null;
          if (nerEl && nerEl.dataset.wordId) {
            nerOpenPopup(parseInt(nerEl.dataset.wordId), e.clientX + 8, e.clientY + 8);
          } else {
            var vrc=document.getElementById('dp-viewer').getBoundingClientRect();
            var sc=getScale();
            var cpx=(e.clientX-vrc.left)/sc, cpy=(e.clientY-vrc.top)/sc;
            var hit=TAGS.find(function(t){
              return cpx>=t.bbox_left && cpy>=t.bbox_top &&
                     cpx<=t.bbox_left+t.bbox_width && cpy<=t.bbox_top+t.bbox_height;
            });
            if (hit) tagOpenExisting(hit);
          }
        }
        state.tagDrawStart = null; state.isDragging = false;
      } else if (state.tagPhase === 'labeling') {
        document.getElementById('dp-tag-sub-rect').style.display = 'none';
        if (state.isDragging && state.tagSubDrawStart) {
          var vr4=document.getElementById('dp-viewer').getBoundingClientRect();
          tagSubSelectInRect(
            Math.min(state.tagSubDrawStart.x,e.clientX)-vr4.left,
            Math.min(state.tagSubDrawStart.y,e.clientY)-vr4.top,
            Math.max(state.tagSubDrawStart.x,e.clientX)-vr4.left,
            Math.max(state.tagSubDrawStart.y,e.clientY)-vr4.top,
            e.shiftKey
          );
        } else if (!state.isDragging) {
          var ghostEl2 = e.target.closest ? e.target.closest('.dp-word-ghost') : null;
          if (ghostEl2 && ghostEl2.dataset.wordId) {
            tagSubWordClick(parseInt(ghostEl2.dataset.wordId), e.shiftKey);
          }
        }
        state.tagSubDrawStart = null; state.isDragging = false;
      }
    } else if (state.activeTab === 'ocr') {
      if (state.drawMode) {
        if (!state.drawOrigin) return;
        var pos2=viewerOffset(e),scale2=getScale(),dx4=Math.min(pos2.x,state.drawOrigin.x),dy4=Math.min(pos2.y,state.drawOrigin.y),dw4=Math.abs(pos2.x-state.drawOrigin.x),dh4=Math.abs(pos2.y-state.drawOrigin.y);
        state.drawOrigin=null; if(dw4<4||dh4<4){setDrawMode(false);return;}
        var pending={left:Math.round(dx4/scale2),top:Math.round(dy4/scale2),width:Math.round(dw4/scale2),height:Math.round(dh4/scale2)};
        state.currentWord=null;state.currentEl=null;
        var popup=document.getElementById('ocr-popup');
        document.getElementById('ocr-popup-original').textContent='New region';document.getElementById('ocr-popup-input').value='';document.getElementById('ocr-popup-confirm').style.display='none';document.getElementById('ocr-popup-delete').style.display='none';
        var vRect=document.getElementById('dp-viewer').getBoundingClientRect(),px5=vRect.left+dx4+dw4+10,py5=vRect.top+dy4+10;if(px5+240>window.innerWidth-16)px5=window.innerWidth-256;
        popup.style.left=px5+'px';popup.style.top=py5+'px';popup.style.display='block';popup._pendingRegion=pending;document.getElementById('ocr-popup-input').focus();
      } else {
        if (!state.selectStart) return;
        if (state.isDragging) {
          var vr5=document.getElementById('dp-viewer').getBoundingClientRect();
          ocrSelectInRect(Math.min(state.selectStart.x,e.clientX)-vr5.left,Math.min(state.selectStart.y,e.clientY)-vr5.top,Math.max(state.selectStart.x,e.clientX)-vr5.left,Math.max(state.selectStart.y,e.clientY)-vr5.top);
          document.getElementById('dp-select-rect').style.display='none';
        } else {
          var wordEl=state.selectStart.target.closest?state.selectStart.target.closest('.ocr-word'):(state.selectStart.target.classList.contains('ocr-word')?state.selectStart.target:null);
          if(wordEl&&wordEl.dataset.wordId){var word=wordById[parseInt(wordEl.dataset.wordId)];if(word){state.suppressClickClose=true;openEditPopup(word,wordEl,e);}}
          else{clearOcrSelection();}
        }
        state.isDragging=false;state.selectStart=null;
      }
    }
    e.stopPropagation()
  }

  document.addEventListener('DOMContentLoaded', function () {
    // OCR toolbar buttons (only present if HAS_REPAIR)
    var confirmAllBtn = document.getElementById('dp-confirm-all');
    if (confirmAllBtn) confirmAllBtn.addEventListener('click',function(e){e.preventDefault();confirmAll();});
    var boxesBtn = document.getElementById('dp-boxes-toggle');
    if (boxesBtn) boxesBtn.addEventListener('click',function(e){e.preventDefault();toggleBoxes();});
    var drawBtn = document.getElementById('dp-draw-toggle');
    if (drawBtn) drawBtn.addEventListener('click',function(e){e.preventDefault();setDrawMode(!state.drawMode);});
    var reclusterBtn = document.getElementById('dp-recluster');
    if (reclusterBtn) reclusterBtn.addEventListener('click',function(e){
      e.preventDefault();var btn=this;btn.disabled=true;btn.textContent='Re-clustering…';
      fetch(RECLUSTER_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''}).then(function(r){return r.json();}).then(function(data){btn.disabled=false;btn.textContent='Re-cluster';if(!data.ok)return;OCR_WORDS=data.updated;wordById={};OCR_WORDS.forEach(function(w){wordById[w.id]=w;});renderOverlays();updateTextPanels();}).catch(function(){btn.disabled=false;btn.textContent='Re-cluster';});
    });
    var resolveDittosBtn = document.getElementById('dp-resolve-dittos');
    if (resolveDittosBtn && RESOLVE_DITTOS_URL) resolveDittosBtn.addEventListener('click',function(e){
      e.preventDefault();var btn=this;btn.disabled=true;btn.textContent='Resolving…';
      fetch(RESOLVE_DITTOS_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''})
      .then(function(r){return r.json();})
      .then(function(data){btn.disabled=false;btn.textContent='Resolve dittos';if(!data.ok)return;data.updated.forEach(function(u){var w=wordById[u.id];if(w)w.corrected_text=u.corrected_text;});renderOverlays();updateTextPanels();})
      .catch(function(){btn.disabled=false;btn.textContent='Resolve dittos';});
    });
    var clearWordsBtn = document.getElementById('dp-clear-words');
    if (clearWordsBtn && CLEAR_WORDS_URL) clearWordsBtn.addEventListener('click',function(e){
      e.preventDefault();
      if(!confirm('Delete all '+OCR_WORDS.length+' words on this page? This cannot be undone.'))return;
      var btn=this;btn.disabled=true;
      fetch(CLEAR_WORDS_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''})
      .then(function(r){return r.json();})
      .then(function(data){btn.disabled=false;if(!data.ok)return;OCR_WORDS=[];wordById={};renderOverlays();updateTextPanels();})
      .catch(function(){btn.disabled=false;});
    });
    var rerunOcrBtn = document.getElementById('dp-rerun-ocr');
    if (rerunOcrBtn && RERUN_OCR_URL) rerunOcrBtn.addEventListener('click',function(e){
      e.preventDefault();var btn=this;btn.disabled=true;btn.textContent='Running OCR…';
      fetch(RERUN_OCR_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''})
      .then(function(r){return r.json();})
      .then(function(data){if(data.ok){window.location.reload();}else{btn.disabled=false;btn.textContent='Rerun OCR';alert('OCR failed: '+(data.error||'unknown'));} })
      .catch(function(){btn.disabled=false;btn.textContent='Rerun OCR';});
    });

    // Mouse handlers
    document.getElementById('dp-viewer').addEventListener('mousedown', onViewerMousedown);
    document.addEventListener('mousemove', onDocMousemove);
    document.addEventListener('mouseup',   onDocMouseup);

    // Coordinate readout
    var coordEl = document.getElementById('dp-coord');
    var wrapEl  = document.getElementById('dp-viewer-wrap');
    if (coordEl && wrapEl) {
      wrapEl.addEventListener('mousemove', function(e) {
        var img = document.getElementById('dp-img');
        if (!img) return;
        var r = img.getBoundingClientRect();
        var ix = e.clientX - r.left, iy = e.clientY - r.top;
        if (ix < 0 || iy < 0 || ix > r.width || iy > r.height) { coordEl.style.display = 'none'; return; }
        var scale = getScale();
        var px = Math.round(ix / scale), py = Math.round(iy / scale);
        coordEl.textContent = px + ', ' + py;
        coordEl.style.display = 'block';
        var wr = wrapEl.getBoundingClientRect();
        coordEl.style.left = (wr.right  - coordEl.offsetWidth  - 8) + 'px';
        coordEl.style.top  = (wr.bottom - coordEl.offsetHeight - 8) + 'px';
      });
      wrapEl.addEventListener('mouseleave', function() { coordEl.style.display = 'none'; });
    }

    // Corner resize handles
    document.querySelectorAll('.dp-tag-corner').forEach(function(handle) {
      handle.addEventListener('mousedown', function(e) {
        if (state.tagPhase !== 'labeling' || !state.tagPendingBbox) return;
        e.preventDefault();
        e.stopPropagation();
        state.tagResizing = {
          corner: handle.dataset.corner,
          startX: e.clientX, startY: e.clientY,
          startBbox: Object.assign({}, state.tagPendingBbox)
        };
      });
    });

    // OCR popup
    var ocpConfirm = document.getElementById('ocr-popup-confirm');
    if (ocpConfirm) ocpConfirm.addEventListener('click',function(e){e.preventDefault();confirmEdit();});
    var ocpDitto = document.getElementById('ocr-popup-ditto');
    if (ocpDitto) ocpDitto.addEventListener('click',function(e){e.preventDefault();markWordAsDitto();});
    var ocpDelete = document.getElementById('ocr-popup-delete');
    if (ocpDelete) ocpDelete.addEventListener('click',function(e){e.preventDefault();deleteWord();});
    var ocpCancel = document.getElementById('ocr-popup-cancel');
    if (ocpCancel) ocpCancel.addEventListener('click',function(e){e.preventDefault();closeEditPopup();if(state.drawMode)setDrawMode(false);});
    var ocpInput = document.getElementById('ocr-popup-input');
    if (ocpInput) ocpInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var p=document.getElementById('ocr-popup');if(p._pendingRegion){saveEdit();return;}e.target.value.trim()===''?confirmEdit():saveEdit();}if(e.key==='Escape'){e.preventDefault();closeEditPopup();if(state.drawMode)setDrawMode(false);}});

    // Merge bar
    var mergeBtn = document.getElementById('ocr-merge-save');
    if (mergeBtn) mergeBtn.addEventListener('click',function(e){e.preventDefault();saveMerge();});
    var joinBtn = document.getElementById('ocr-join-line');
    if (joinBtn) joinBtn.addEventListener('click',function(e){e.preventDefault();joinLine();});
    var bulkDittoBtn = document.getElementById('ocr-bulk-ditto');
    if (bulkDittoBtn) bulkDittoBtn.addEventListener('click',function(e){e.preventDefault();bulkDitto();});
    var bulkDeleteBtn = document.getElementById('ocr-bulk-delete');
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click',function(e){e.preventDefault();bulkDelete();});
    var mergeCancelBtn = document.getElementById('ocr-merge-cancel');
    if (mergeCancelBtn) mergeCancelBtn.addEventListener('click',function(e){e.preventDefault();state.ocrSelectedIds.clear();document.getElementById('ocr-merge-bar').style.display='none';clearOcrSelection();});
    var mergeInput = document.getElementById('ocr-merge-input');
    if (mergeInput) mergeInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();saveMerge();}if(e.key==='Escape'){e.preventDefault();state.ocrSelectedIds.clear();document.getElementById('ocr-merge-bar').style.display='none';clearOcrSelection();}});

    // Global click: close popups / clear OCR selections
    document.addEventListener('click',function(e){
      if(state.suppressClickClose){state.suppressClickClose=false;return;}
      var popup=document.getElementById('ocr-popup');
      if(popup.style.display!=='none'&&!popup.contains(e.target)&&!popup._pendingRegion)closeEditPopup();
      if(!e.target.closest('#dp-viewer')&&!e.target.closest('#ocr-merge-bar'))clearOcrSelection();
    });

    // Tag panel buttons
    document.getElementById('dp-tag-save-btn').addEventListener('click',function(e){e.preventDefault();tagSave();});
    document.getElementById('dp-tag-cancel-btn').addEventListener('click',function(e){e.preventDefault();tagExitLabelingMode();});
    document.getElementById('dp-tag-delete-btn').addEventListener('click',function(e){e.preventDefault();tagDelete();});
    document.getElementById('dp-tag-sub-clear-btn').addEventListener('click',function(e){
      e.preventDefault();
      // Remove all currently selected words from the pattern
      state.tagSubSelectedIds.forEach(function(wid){
        var idx = state.tagPendingSubcomps.findIndex(function(s){ return s.word_id === wid; });
        if (idx >= 0) state.tagPendingSubcomps.splice(idx, 1);
      });
      state.tagSubSelectedIds.clear();
      document.getElementById('dp-tag-sub-input').value = '';
      document.getElementById('dp-tag-sub-input-row').style.display = 'none';
      tagUpdateSubcompDisplay();
      renderOverlays();
    });

    // Person modal
    var dppSave = document.getElementById('dpp-save');
    if (dppSave) dppSave.addEventListener('click',function(e){e.preventDefault();savePersonModal();});
    var dppCancel = document.getElementById('dpp-cancel');
    if (dppCancel) dppCancel.addEventListener('click',function(e){e.preventDefault();closePersonModal();});
    var personBackdrop = document.getElementById('dp-person-backdrop');
    if (personBackdrop) personBackdrop.addEventListener('click',function(e){if(e.target===this)closePersonModal();});
    var personModal = document.getElementById('dp-person-modal');
    if (personModal) personModal.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();savePersonModal();}if(e.key==='Escape'){e.preventDefault();closePersonModal();}});
  });

  /* ── init ──────────────────────────────────────────────────── */
  document.querySelectorAll('a.dp-nav-btn:not(.disabled)').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); navigate(btn.getAttribute('href')); });
  });

  // Populate page-jump select if present
  var pageSelect = document.getElementById('dp-page-select');
  if (pageSelect && PAGE_LIST) {
    PAGE_LIST.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.url;
      opt.textContent = 'p. ' + p.page_number;
      if (p.pk === CURRENT_PAGE_PK) opt.selected = true;
      pageSelect.appendChild(opt);
    });
    pageSelect.addEventListener('change', function() { navigate(this.value); });
  }

  tagBuildList();
  tagRenderTagOverlays();
  tagPopulateLabelDatalist();
  if (state.activeTab !== 'ocr') dpShowTab(state.activeTab);
  else { dpShowTab('ocr'); }

  var img = document.getElementById('dp-img');
  if (img) {
    if (img.complete) { dpFit(); updateBadge(); updateTextPanels(); }
    else { img.addEventListener('load', function () { dpFit(); updateBadge(); updateTextPanels(); }); }
  }

  document.getElementById('dp-viewer-wrap').addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (e.deltaY < 0) dpZoomIn(); else dpZoomOut();
  }, { passive: false });

  /* ── keyboard ──────────────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = tag==='INPUT'||tag==='TEXTAREA'||(document.activeElement&&document.activeElement.isContentEditable);
    if (e.key==='ArrowLeft'  && !inInput && PREV_URL) { navigate(PREV_URL); return; }
    if (e.key==='ArrowRight' && !inInput && NEXT_URL) { navigate(NEXT_URL); return; }

    if (state.activeTab === 'tagging' && state.tagPhase === 'labeling') {
      var subInput = document.getElementById('dp-tag-sub-input');
      var labelInput = document.getElementById('dp-tag-label-input');
      var subActive = subInput && subInput.parentElement.style.display !== 'none' && document.activeElement === subInput;
      if (e.key === 'Enter') {
        if (subActive) { e.preventDefault(); tagConfirmSubLabel(subInput.value); return; }
        if (document.activeElement === labelInput) { e.preventDefault(); labelInput.blur(); return; }
        e.preventDefault(); tagSave(); return;
      }
      if (e.key === 'Escape') {
        if (subActive) {
          e.preventDefault();
          state.tagSubSelectedIds.clear();
          document.getElementById('dp-tag-sub-input-row').style.display = 'none';
          renderOverlays();
          return;
        }
        e.preventDefault(); tagExitLabelingMode(); return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !subActive && document.activeElement !== labelInput && state.tagSubSelectedIds.size > 0) {
        e.preventDefault();
        state.tagSubSelectedIds.forEach(function(wid) {
          var idx = state.tagPendingSubcomps.findIndex(function(s){ return s.word_id === wid; });
          if (idx >= 0) state.tagPendingSubcomps.splice(idx, 1);
        });
        state.tagSubSelectedIds.clear();
        document.getElementById('dp-tag-sub-input-row').style.display = 'none';
        tagUpdateSubcompDisplay();
        renderOverlays();
        return;
      }
    }

    if (HAS_REPAIR) {
      if (e.key==='Escape' && state.activeTab === 'ocr') { closeEditPopup(); state.ocrSelectedIds.clear(); document.getElementById('ocr-merge-bar').style.display='none'; return; }
      if ((e.ctrlKey||e.metaKey)&&!inInput){if(e.key==='z'&&!e.shiftKey){e.preventDefault();undo();return;}if(e.key==='y'||(e.key==='z'&&e.shiftKey)){e.preventDefault();redo();return;}}
      if (inInput) return;
      if (state.activeTab==='ocr'){if(e.key==='a'){e.preventDefault();setDrawMode(!state.drawMode);return;}if(e.key==='m'&&state.ocrSelectedIds.size>=2){e.preventDefault();saveMerge();return;}if((e.key==='ArrowUp'||e.key==='ArrowDown')&&state.ocrSelectedIds.size){e.preventDefault();reorderLine(e.key==='ArrowDown'?'down':'up');}}
    }
  });
})();
