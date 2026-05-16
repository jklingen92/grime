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
  var CLEAR_WORDS_URL    = C.clearWordsUrl || null;
  var RESOLVE_DITTOS_URL = C.resolveDittosUrl || null;
  var MARK_AS_DITTO_URL  = C.markAsDittoUrl || null;
  var BULK_DITTO_URL     = C.bulkDittoUrl || null;
  var BULK_DELETE_URL    = C.bulkDeleteUrl || null;
  var RERUN_SELECTION_URL = C.rerunSelectionUrl || null;
  var NER_RERUN_URL = C.nerRerunUrl || null;
  var PAGE_LIST      = C.pageList || null;
  var CURRENT_PAGE_PK = C.currentPagePk || null;

  var wordById = {};
  OCR_WORDS.forEach(function (w) { if (w.id != null) wordById[w.id] = w; });

  var state = {
    activeTab:          (function(){ var t = new URLSearchParams(window.location.search).get('tab'); if (t === 'tagging') t = 'label'; return (t === 'ocr' || t === 'ner' || t === 'label') ? t : 'ocr'; })(),
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
    nerSelectedIds:     new Set(),
    nerHighlightKey:    null,
    // person
    personGroupsLoaded: false,
    // OCR interaction
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
    ['ocr','ner','label'].forEach(function(n){
      var t = document.getElementById('tab-' + n);
      if (t) t.classList.toggle('active', name === n);
    });
    var actions   = document.getElementById('dp-ocr-actions');
    var sep       = document.getElementById('dp-sep-ocr');
    var nerSep    = document.getElementById('dp-sep-ner');
    var nerBtn    = document.getElementById('dp-rerun-ner');
    var tagP      = document.getElementById('dp-tag-panel');
    var nerP      = document.getElementById('dp-ner-panel');
    var txtP      = document.getElementById('dp-text-panel');

    if (actions) { actions.classList.toggle('visible', name === 'ocr'); if (sep) sep.style.display = (name === 'ocr') ? '' : 'none'; }
    if (nerSep) nerSep.style.display = (name === 'ner') ? '' : 'none';
    if (nerBtn) nerBtn.style.display = (name === 'ner') ? '' : 'none';
    if (txtP) txtP.classList.toggle('visible', name === 'ocr');
    if (nerP) nerP.classList.toggle('visible', name === 'ner');
    if (tagP) tagP.classList.toggle('visible', name === 'label');

    clearOcrSelection();
    clearNerSelection();
    if (name === 'ner') nerBuildEntityList();
    renderOverlays();
    updateBadge();
  }
  window.dpShowTab = dpShowTab;

  function updateBadge() {
    var el = document.getElementById('dp-tab-badge');
    if (!el) return;
    if (state.activeTab === 'label') {
      el.textContent = TAGS.length ? TAGS.length + ' label' + (TAGS.length === 1 ? '' : 's') : 'No labels';
    } else if (state.activeTab === 'ner') {
      var n = OCR_WORDS.filter(function(w){ return nerEntityType(w); }).length;
      el.textContent = n ? n + ' entity word' + (n === 1 ? '' : 's') : 'No NER data';
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
    var raw = w.corrected_label || w.ner_label;
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
    var wrap = document.getElementById('dp-viewer-wrap');
    var rect = wrap.getBoundingClientRect();
    popup.style.left = (rect.right - 8) + 'px';
    popup.style.top  = (rect.top + 8) + 'px';
    popup.style.display = 'block';
  }

  function nerClosePopup() {
    document.getElementById('dp-ner-popup').style.display = 'none';
    state.nerPopupWordId = null;
  }

  /* ── NER multi-select ──────────────────────────────────────── */
  function clearNerSelection() {
    state.nerSelectedIds.clear();
    updateNerSelectBar();
    if (state.activeTab === 'ner') renderOverlays();
  }

  function updateNerSelectBar() {
    var bar = document.getElementById('ner-select-bar');
    if (!bar) return;
    var n = state.nerSelectedIds.size;
    if (n < 2) { bar.style.display = 'none'; return; }
    var label = document.getElementById('ner-select-label');
    if (label) label.textContent = n + ' word' + (n === 1 ? '' : 's') + ' selected';
    var wrap = document.getElementById('dp-viewer-wrap');
    var rect = wrap.getBoundingClientRect();
    bar.style.left = (rect.right - 8) + 'px';
    bar.style.top = (rect.top + 8) + 'px';
    bar.style.display = 'flex';
    // Prefill dropdown with majority current type, if any
    var sel = document.getElementById('ner-select-type');
    if (sel) {
      var counts = {};
      state.nerSelectedIds.forEach(function(id){
        var t = nerEntityType(wordById[id]);
        if (t) counts[t] = (counts[t] || 0) + 1;
      });
      var best = '', bestN = 0;
      Object.keys(counts).forEach(function(k){ if (counts[k] > bestN) { best = k; bestN = counts[k]; } });
      if (best) sel.value = best;
    }
  }

  function nerSelectInRect(x1, y1, x2, y2, shiftKey) {
    var s = getScale(), px1 = x1/s, py1 = y1/s, px2 = x2/s, py2 = y2/s;
    if (!shiftKey) state.nerSelectedIds.clear();
    OCR_WORDS.forEach(function(w){
      if ((w.left+w.width) > px1 && w.left < px2 && (w.top+w.height) > py1 && w.top < py2) {
        state.nerSelectedIds.add(w.id);
      }
    });
    updateNerSelectBar();
    renderOverlays();
  }

  function nerApplyBulkLabel(type) {
    if (!state.nerSelectedIds.size) return;
    var ids = Array.from(state.nerSelectedIds);
    // Find leftmost (then topmost as tiebreaker) → B-, others → I-
    ids.sort(function(a, b){
      var wa = wordById[a], wb = wordById[b];
      if (!wa || !wb) return 0;
      if (wa.left !== wb.left) return wa.left - wb.left;
      return wa.top - wb.top;
    });
    var requests = ids.map(function(id, idx){
      var label;
      if (type === 'NONE' || !type) label = 'NONE';
      else label = (idx === 0 ? 'B-' : 'I-') + type;
      return fetch(NER_CORRECT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN },
        body: 'word_id=' + id + '&label=' + encodeURIComponent(label)
      }).then(function(r){ return r.json(); }).then(function(data){
        if (data && data.ok) {
          var w = wordById[id];
          if (w) w.corrected_label = (label === 'NONE') ? null : label;
        }
      });
    });
    Promise.all(requests).then(function(){
      state.nerSelectedIds.clear();
      updateNerSelectBar();
      nerBuildEntityList();
      renderOverlays();
    });
  }

  /* ── NER entity list (side panel) ──────────────────────────── */
  function nerBuildEntities() {
    // Walk words in reading order; B-X starts a new entity, I-X extends current if same type.
    var ents = []; // {type, text, wordIds: [...]}
    var sorted = OCR_WORDS.slice().sort(function(a, b){
      if (a.line_num !== b.line_num) return (a.line_num||0) - (b.line_num||0);
      return (a.word_num||0) - (b.word_num||0);
    });
    var cur = null;
    sorted.forEach(function(w){
      var raw = nerEffectiveLabel(w);
      if (!raw) { cur = null; return; }
      var type = raw.replace(/^[BI]-/, '');
      var prefix = raw.charAt(0);
      if (prefix === 'B' || !cur || cur.type !== type) {
        cur = { type: type, words: [w] };
        ents.push(cur);
      } else {
        cur.words.push(w);
      }
    });
    return ents.map(function(e){
      var text = e.words.map(function(w){ return w.corrected_text != null ? w.corrected_text : w.text; }).join(' ');
      return { type: e.type, text: text, wordIds: e.words.map(function(w){ return w.id; }) };
    });
  }

  function nerBuildEntityList() {
    var ents = nerBuildEntities();
    var byType = { PER: {}, LOC: {}, ORG: {} };
    ents.forEach(function(e){
      if (!byType[e.type]) byType[e.type] = {};
      var key = e.text.trim().toLowerCase();
      if (!key) return;
      if (!byType[e.type][key]) byType[e.type][key] = { type: e.type, text: e.text, count: 0, wordIds: [] };
      byType[e.type][key].count += 1;
      byType[e.type][key].wordIds = byType[e.type][key].wordIds.concat(e.wordIds);
    });
    ['PER', 'LOC', 'ORG'].forEach(function(t){
      var section = document.querySelector('.dp-ner-section[data-type="' + t + '"]');
      if (!section) return;
      var body = section.querySelector('.dp-ner-section-body');
      var countEl = section.querySelector('.dp-ner-section-count');
      var items = Object.keys(byType[t] || {}).map(function(k){ return byType[t][k]; });
      items.sort(function(a, b){ return b.count - a.count; });
      countEl.textContent = '(' + items.length + ')';
      body.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'dp-ner-entity-empty';
        empty.textContent = 'No entities.';
        body.appendChild(empty);
        return;
      }
      items.forEach(function(item){
        var row = document.createElement('div');
        row.className = 'dp-ner-entity-row ner-' + t;
        var key = t + ':' + item.text.trim().toLowerCase();
        if (state.nerHighlightKey === key) row.classList.add('active');
        var txt = document.createElement('span');
        txt.className = 'dp-ner-entity-text';
        txt.textContent = item.text;
        var cnt = document.createElement('span');
        cnt.className = 'dp-ner-entity-count';
        cnt.textContent = item.count;
        row.appendChild(txt); row.appendChild(cnt);
        row.addEventListener('click', function(){
          state.nerHighlightKey = (state.nerHighlightKey === key) ? null : key;
          nerBuildEntityList();
          renderOverlays();
        });
        body.appendChild(row);
      });
    });
  }

  function nerHighlightWordIdSet() {
    var ids = new Set();
    if (!state.nerHighlightKey) return ids;
    var parts = state.nerHighlightKey.split(':');
    var type = parts[0], key = parts.slice(1).join(':');
    nerBuildEntities().forEach(function(e){
      if (e.type === type && e.text.trim().toLowerCase() === key) {
        e.wordIds.forEach(function(id){ ids.add(id); });
      }
    });
    return ids;
  }

  document.addEventListener('click', function(e) {
    if (state.suppressClickClose) return;
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
      if (w) { w.corrected_label = (label === 'NONE') ? null : (label || null); }
      nerClosePopup();
      nerBuildEntityList();
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

    if (state.activeTab === 'ner') {
      var highlightWordIds = nerHighlightWordIdSet();
      OCR_WORDS.forEach(function(w) {
        var entityType = nerEntityType(w);
        var className = "dp-ner-overlay";
        if (!entityType) className += " ner-NONE";
        else className += " ner-" + entityType;
        if (state.nerSelectedIds.has(w.id)) className += ' selected';
        if (highlightWordIds.has(w.id)) className += ' entity-highlight';
        var div = document.createElement('div');
        div.className = className;
        div.dataset.wordId = w.id;
        div.style.left   = Math.round(w.left   * scale) + 'px';
        div.style.top    = Math.round(w.top    * scale) + 'px';
        div.style.width  = Math.round(w.width  * scale) + 'px';
        div.style.height = Math.round(w.height * scale) + 'px';
        div.title = (nerEffectiveLabel(w) || '') + ': ' + (w.corrected_text || w.text);
        viewer.appendChild(div);
      });

    } else if (state.activeTab === 'label') {
      // Ghost word boxes — only in labeling mode (draw mode shows tag overlays)
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
      if (w.line_num == null) return;
      var key = String(w.line_num);
      if (!lineMap[key]) lineMap[key] = { l: w.line_num, words: [] };
      lineMap[key].words.push(w);
    });
    var lines = Object.values(lineMap);
    lines.sort(function (a,b) { return a.l - b.l; });
    lines.forEach(function(line){ line.words.sort(function(a,b){return a.word_num-b.word_num;}); });
    return lines;
  }

  function buildFullText() {
    if (!OCR_WORDS.length) return '';
    var lines = _buildLineMap(), out = [];
    lines.forEach(function (line) {
      out.push(line.words.filter(function(w){return(w.corrected_text||w.text||'').trim();})
        .map(function(w){return w.corrected_text!=null?w.corrected_text:w.text;}).join(' '));
    });
    return out.join('\n');
  }

  function updateTextPanels() {
    var ocr = document.getElementById('dp-corrected-text');
    if (!ocr) return;
    ocr.innerHTML = '';
    var lines = _buildLineMap();
    lines.forEach(function (line) {
      var lineDiv = document.createElement('div');
      lineDiv.className = 'dp-text-line';
      line.words.filter(function(w){return(w.corrected_text||w.text||'').trim();})
        .forEach(function(w){
          var wordSpan = document.createElement('span');
          wordSpan.className = 'dp-text-word';
          if (state.ocrSelectedIds.has(w.id)) wordSpan.classList.add('selected');
          if (_searchQuery && (w.corrected_text!=null?w.corrected_text:w.text||'').toLowerCase().indexOf(_searchQuery) >= 0) wordSpan.classList.add('search-match');
          wordSpan.textContent = w.corrected_text!=null?w.corrected_text:w.text;
          wordSpan.dataset.wordId = w.id;
          (function(wid) {
            wordSpan.addEventListener('click', function(e) {
              if (!e.shiftKey) state.ocrSelectedIds.clear();
              if (state.ocrSelectedIds.has(wid)) state.ocrSelectedIds.delete(wid);
              else state.ocrSelectedIds.add(wid);
              document.querySelectorAll('.ocr-word').forEach(function(el) {
                el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
              });
              updateOcrMergeBar();
              updateTextPanels();
            });
          })(w.id);
          lineDiv.appendChild(wordSpan);
          var space = document.createTextNode(' ');
          lineDiv.appendChild(space);
        });
      if (lineDiv.textContent.trim()) ocr.appendChild(lineDiv);
    });
  }

  /* ── text-panel search ─────────────────────────────────────── */
  var _searchQuery = '';

  function applyTextSearch(query) {
    _searchQuery = (query || '').trim().toLowerCase();
    var matchIds = new Set();
    if (_searchQuery) {
      OCR_WORDS.forEach(function(w) {
        var t = (w.corrected_text != null ? w.corrected_text : w.text || '').toLowerCase();
        if (t.indexOf(_searchQuery) >= 0 && w.id != null) matchIds.add(w.id);
      });
    }
    var count = matchIds.size;
    var countEl = document.getElementById('dp-text-search-count');
    if (countEl) countEl.textContent = _searchQuery ? (count ? count + ' match' + (count === 1 ? '' : 'es') : 'no matches') : '';

    // Update search-match class in text panel
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(el) {
      el.classList.toggle('search-match', matchIds.has(parseInt(el.dataset.wordId)));
    });

    // Select matched words on document overlay (replace non-shift always here)
    if (_searchQuery) {
      state.ocrSelectedIds.clear();
      matchIds.forEach(function(id) { state.ocrSelectedIds.add(id); });
      document.querySelectorAll('.ocr-word').forEach(function(el) {
        el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
      });
      updateOcrMergeBar();
      // scroll first match into view in text panel
      var first = document.querySelector('#dp-corrected-text .dp-text-word.search-match');
      if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      state.ocrSelectedIds.clear();
      document.querySelectorAll('.ocr-word.selected').forEach(function(el) { el.classList.remove('selected'); });
      updateOcrMergeBar();
    }
    // Sync selected class on text words
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
  }

  /* ── text-panel native selection → document word selection ─── */
  function onTextPanelMouseup(e) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var wordSpans = document.querySelectorAll('#dp-corrected-text .dp-text-word');
    var hitIds = [];
    wordSpans.forEach(function(span) {
      var spanRange = document.createRange();
      spanRange.selectNode(span);
      if (range.compareBoundaryPoints(Range.END_TO_START, spanRange) <= 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, spanRange) >= 0) {
        var id = parseInt(span.dataset.wordId);
        if (!isNaN(id)) hitIds.push(id);
      }
    });
    if (!hitIds.length) return;
    if (!e.shiftKey) state.ocrSelectedIds.clear();
    hitIds.forEach(function(id) { state.ocrSelectedIds.add(id); });
    document.querySelectorAll('.ocr-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
    updateOcrMergeBar();
    updateTextPanels();
    // Clear browser selection so it doesn't fight with our visual state
    sel.removeAllRanges();
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
    updateTextPanels();
  }

  function updateOcrMergeBar() {
    var bar=document.getElementById('ocr-merge-bar');
    if (!bar) return;
    var n=state.ocrSelectedIds.size;
    if (n<2){bar.style.display='none';return;}
    var label=document.getElementById('ocr-merge-label');
    if (label) label.textContent=n+' word'+(n===1?'':'s')+' selected';
    var wrap=document.getElementById('dp-viewer-wrap');
    var rect=wrap.getBoundingClientRect();
    bar.style.left=(rect.right-8)+'px';bar.style.top=(rect.top+8)+'px';
    bar.style.display='flex';
  }

  function selectAllOcrWords() {
    state.ocrSelectedIds.clear();
    OCR_WORDS.forEach(function(w){ if (w.id != null) state.ocrSelectedIds.add(w.id); });
    document.querySelectorAll('.ocr-word').forEach(function(el){
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
    updateOcrMergeBar();
    updateTextPanels();
  }

  function ocrBtnLabel() {
    return OCR_WORDS.length ? 'Rerun OCR' : 'Run OCR';
  }

  function runOcr(engine) {
    if (!RERUN_SELECTION_URL) return;
    var btn = document.getElementById('dp-rerun-ocr');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    var parts = ['engine=' + encodeURIComponent(engine || 'textract')];
    if (state.ocrSelectedIds.size) {
      parts.push('word_pks=' + encodeURIComponent(Array.from(state.ocrSelectedIds).join(',')));
    }
    var body = parts.join('&');
    fetch(RERUN_SELECTION_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: body
    }).then(function(r){ return r.json(); }).then(function(data) {
      if (!data.ok) {
        if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); }
        alert(data.error || 'OCR failed.');
        return;
      }
      var del = new Set(data.deleted_ids);
      OCR_WORDS = OCR_WORDS.filter(function(w){ return !del.has(w.id); });
      data.deleted_ids.forEach(function(id){ delete wordById[id]; });
      (data.new_words || []).forEach(function(w){ OCR_WORDS.push(w); wordById[w.id] = w; });
      state.ocrSelectedIds.clear();
      var bar = document.getElementById('ocr-merge-bar'); if (bar) bar.style.display = 'none';
      renderOverlays();
      updateTextPanels();
      if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); }
    }).catch(function(){
      if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); }
    });
  }

  function nerBtnLabel() {
    var hasNer = OCR_WORDS.some(function(w){ return w.ner_label || w.corrected_label; });
    return hasNer ? 'Rerun NER' : 'Run NER';
  }

  function runNer() {
    if (!NER_RERUN_URL) return;
    var btn = document.getElementById('dp-rerun-ner');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    fetch(NER_RERUN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: ''
    }).then(function(r){ return r.json(); }).then(function(data) {
      if (!data.ok) {
        if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); }
        alert(data.error || 'NER failed.');
        return;
      }
      data.words.forEach(function(w) {
        var word = wordById[w.id];
        if (word) { word.ner_label = w.ner_label; word.corrected_label = w.corrected_label; }
      });
      nerBuildEntityList();
      renderOverlays();
      updateBadge();
      if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); }
    }).catch(function(){
      if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); }
    });
  }

  function rerunSelectionOcr() {
    if (!RERUN_SELECTION_URL || !state.ocrSelectedIds.size) return;
    var btn = document.getElementById('ocr-rerun-ocr');
    var pks = Array.from(state.ocrSelectedIds);
    if (btn) { btn.disabled = true; btn.textContent = 'Rerunning…'; }
    fetch(RERUN_SELECTION_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': CSRF_TOKEN},
      body: 'engine=textract&word_pks=' + encodeURIComponent(pks.join(','))
    }).then(function(r){ return r.json(); }).then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Rerun OCR'; }
      if (!data.ok) { alert(data.error || 'Rerun OCR failed.'); return; }
      var del = new Set(data.deleted_ids);
      OCR_WORDS = OCR_WORDS.filter(function(w){ return !del.has(w.id); });
      data.deleted_ids.forEach(function(id){ delete wordById[id]; });
      (data.new_words || []).forEach(function(w){ OCR_WORDS.push(w); wordById[w.id] = w; });
      state.ocrSelectedIds.clear();
      var bar = document.getElementById('ocr-merge-bar'); if (bar) bar.style.display = 'none';
      renderOverlays();
      updateTextPanels();
    }).catch(function(){
      if (btn) { btn.disabled = false; btn.textContent = 'Rerun OCR'; }
    });
  }

  function ocrSelectInRect(x1,y1,x2,y2, shiftKey) {
    var s=getScale(), px1=x1/s, py1=y1/s, px2=x2/s, py2=y2/s;
    if (!shiftKey) {state.ocrSelectedIds.clear();}
    OCR_WORDS.forEach(function(w){if((w.left+w.width)>px1&&w.left<px2&&(w.top+w.height)>py1&&w.top<py2)state.ocrSelectedIds.add(w.id);});
    document.querySelectorAll('.ocr-word').forEach(function(el){el.classList.toggle('selected',state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));});
    updateOcrMergeBar();
    updateTextPanels();
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
    var wrap = document.getElementById('dp-viewer-wrap');
    var rect = wrap.getBoundingClientRect();
    popup.style.left=(rect.right-8)+'px';popup.style.top=(rect.top+8)+'px';popup.style.display='block';
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
  function confirmAll(){var btn=document.getElementById('dp-confirm-all');btn.disabled=true;btn.textContent='Confirming…';fetch(CONFIRM_ALL_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:''}).then(function(r){return r.json();}).then(function(data){if(!data.ok){btn.disabled=false;btn.textContent='Confirm all';return;}data.updated.forEach(function(u){var w=wordById[u.id];if(w)w.corrected_text=u.corrected_text;});renderOverlays();updateTextPanels();btn.textContent='Confirmed ('+data.updated.length+')';setTimeout(function(){btn.disabled=false;btn.textContent='Confirm all';},2000);}).catch(function(){btn.disabled=false;btn.textContent='Confirm all';});}
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
      updateOcrMergeBar();
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
      updateOcrMergeBar();
    });
  }

  function toggleBoxes(){state.boxesHidden=!state.boxesHidden;document.getElementById('dp-viewer').classList.toggle('hide-boxes',state.boxesHidden);document.getElementById('dp-boxes-toggle').textContent=state.boxesHidden?'Show boxes':'Hide boxes';}

  function viewerOffset(e){var r=document.getElementById('dp-viewer').getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  function setDrawMode(active){state.drawMode=active;var v=document.getElementById('dp-viewer'),btn=document.getElementById('dp-draw-toggle');if(active){v.classList.add('draw-mode');btn.textContent='Cancel draw';btn.style.background='#e67e00';btn.style.color='#fff';}else{v.classList.remove('draw-mode');btn.textContent='Add region (a)';btn.style.background='';btn.style.color='';document.getElementById('dp-draw-rect').style.display='none';state.drawOrigin=null;}}
  function saveAddRegion(pending,text){fetch(ADD_WORD_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRFToken':CSRF_TOKEN},body:'left='+pending.left+'&top='+pending.top+'&width='+pending.width+'&height='+pending.height+'&corrected_text='+encodeURIComponent(text)}).then(function(r){return r.json();}).then(function(data){if(!data.ok)return;OCR_WORDS.push(data.word);wordById[data.word.id]=data.word;recordUndo({type:'add',wordId:data.word.id});renderOverlays();updateTextPanels();document.getElementById('dp-draw-rect').style.display='none';});}

  /* ── unified mouse handling ────────────────────────────────── */
  function onViewerMousedown(e) {
    if (state.activeTab === 'label') {
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
    } else if (state.activeTab === 'ner') {
      e.preventDefault();
      state.selectStart = { x: e.clientX, y: e.clientY, target: e.target };
      state.isDragging = false;
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
    if (state.activeTab === 'ner') {
      if (!state.selectStart) return;
      var ndx = e.clientX - state.selectStart.x, ndy = e.clientY - state.selectStart.y;
      if (!state.isDragging && Math.sqrt(ndx*ndx + ndy*ndy) > 5) {
        state.isDragging = true;
        if (!e.shiftKey) clearNerSelection();
      }
      if (state.isDragging) {
        var nvr = document.getElementById('dp-viewer').getBoundingClientRect();
        var nsr = document.getElementById('dp-select-rect');
        nsr.style.left   = Math.min(state.selectStart.x, e.clientX) - nvr.left + 'px';
        nsr.style.top    = Math.min(state.selectStart.y, e.clientY) - nvr.top  + 'px';
        nsr.style.width  = Math.abs(e.clientX - state.selectStart.x) + 'px';
        nsr.style.height = Math.abs(e.clientY - state.selectStart.y) + 'px';
        nsr.style.display = 'block';
      }
      return;
    }
    if (state.activeTab === 'label') {
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
        if (!state.isDragging&&Math.sqrt(dx3*dx3+dy3*dy3)>5){state.isDragging=true;if(!e.shiftKey)clearOcrSelection();}
        if (state.isDragging){var vr3=document.getElementById('dp-viewer').getBoundingClientRect(),sr3=document.getElementById('dp-select-rect');sr3.style.left=Math.min(state.selectStart.x,e.clientX)-vr3.left+'px';sr3.style.top=Math.min(state.selectStart.y,e.clientY)-vr3.top+'px';sr3.style.width=Math.abs(e.clientX-state.selectStart.x)+'px';sr3.style.height=Math.abs(e.clientY-state.selectStart.y)+'px';sr3.style.display='block';}
      }
    }
  }

  function onDocMouseup(e) {
    if (state.activeTab === 'ner') {
      if (!state.selectStart) return;
      var nvr2 = document.getElementById('dp-viewer').getBoundingClientRect();
      if (state.isDragging) {
        nerSelectInRect(
          Math.min(state.selectStart.x, e.clientX) - nvr2.left,
          Math.min(state.selectStart.y, e.clientY) - nvr2.top,
          Math.max(state.selectStart.x, e.clientX) - nvr2.left,
          Math.max(state.selectStart.y, e.clientY) - nvr2.top,
          e.shiftKey
        );
        document.getElementById('dp-select-rect').style.display = 'none';
      } else {
        var nerEl = state.selectStart.target.closest ? state.selectStart.target.closest('.dp-ner-overlay') : null;
        if (nerEl && nerEl.dataset.wordId) {
          var nwid = parseInt(nerEl.dataset.wordId);
          if (e.shiftKey) {
            if (state.nerSelectedIds.has(nwid)) state.nerSelectedIds.delete(nwid);
            else state.nerSelectedIds.add(nwid);
            updateNerSelectBar();
            renderOverlays();
          } else {
            state.suppressClickClose = true;
            clearNerSelection();
            nerOpenPopup(nwid, e.clientX + 8, e.clientY + 8);
          }
        } else if (!e.shiftKey) {
          clearNerSelection();
        }
      }
      state.isDragging = false; state.selectStart = null;
      e.stopPropagation();
      return;
    }
    if (state.activeTab === 'label') {
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
        var wrap=document.getElementById('dp-viewer-wrap'),wRect=wrap.getBoundingClientRect();
        popup.style.left=(wRect.right-8)+'px';popup.style.top=(wRect.top+8)+'px';popup.style.display='block';popup._pendingRegion=pending;document.getElementById('ocr-popup-input').focus();
      } else {
        if (!state.selectStart) return;
        if (state.isDragging) {
          var vr5=document.getElementById('dp-viewer').getBoundingClientRect();
          ocrSelectInRect(Math.min(state.selectStart.x,e.clientX)-vr5.left,Math.min(state.selectStart.y,e.clientY)-vr5.top,Math.max(state.selectStart.x,e.clientX)-vr5.left,Math.max(state.selectStart.y,e.clientY)-vr5.top, e.shiftKey);
          document.getElementById('dp-select-rect').style.display='none';
        } else {
          var wordEl=state.selectStart.target.closest?state.selectStart.target.closest('.ocr-word'):(state.selectStart.target.classList.contains('ocr-word')?state.selectStart.target:null);
          if(wordEl&&wordEl.dataset.wordId){
            var wid=parseInt(wordEl.dataset.wordId), word=wordById[wid];
            if (word) {
              if (e.shiftKey) {
                // Shift-click toggles word into the multi-select set instead of opening the popup.
                if (state.ocrSelectedIds.has(wid)) state.ocrSelectedIds.delete(wid);
                else state.ocrSelectedIds.add(wid);
                wordEl.classList.toggle('selected', state.ocrSelectedIds.has(wid));
                updateOcrMergeBar();
                updateTextPanels();
              } else {
                state.suppressClickClose=true;
                openEditPopup(word,wordEl,e);
              }
            }
          }
          else{if(!e.shiftKey)clearOcrSelection();}
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
    var rerunCaretBtn = document.getElementById('dp-rerun-ocr-caret');
    var rerunMenu = document.getElementById('dp-rerun-ocr-menu');
    if (rerunOcrBtn) {
      rerunOcrBtn.textContent = ocrBtnLabel();
      rerunOcrBtn.addEventListener('click', function(e){
        e.preventDefault();
        runOcr(state.ocrEngine || 'textract');
      });
    }
    var rerunNerBtn = document.getElementById('dp-rerun-ner');
    if (rerunNerBtn) {
      rerunNerBtn.textContent = nerBtnLabel();
      rerunNerBtn.addEventListener('click', function(e){
        e.preventDefault();
        runNer();
      });
    }
    if (rerunCaretBtn && rerunMenu) {
      rerunCaretBtn.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        rerunMenu.classList.toggle('open');
      });
      rerunMenu.querySelectorAll('[data-engine]').forEach(function(item){
        item.addEventListener('click', function(e){
          e.preventDefault();
          state.ocrEngine = item.dataset.engine;
          rerunMenu.querySelectorAll('[data-engine]').forEach(function(i){
            i.classList.toggle('active', i === item);
          });
          rerunMenu.classList.remove('open');
          runOcr(state.ocrEngine);
        });
      });
    }

    // Mouse handlers
    document.getElementById('dp-viewer').addEventListener('mousedown', onViewerMousedown);
    document.addEventListener('mousemove', onDocMousemove);
    document.addEventListener('mouseup',   onDocMouseup);

    // Text-panel search
    var searchInput = document.getElementById('dp-text-search');
    if (searchInput) {
      searchInput.addEventListener('input', function() { applyTextSearch(this.value); });
      searchInput.addEventListener('keydown', function(e) { if (e.key === 'Escape') { this.value = ''; applyTextSearch(''); } });
    }

    // Text-panel native selection → document word selection
    var correctedText = document.getElementById('dp-corrected-text');
    if (correctedText) correctedText.addEventListener('mouseup', onTextPanelMouseup);

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

    // Selection bar
    var rerunBtn = document.getElementById('ocr-rerun-ocr');
    if (rerunBtn) rerunBtn.addEventListener('click',function(e){e.preventDefault();rerunSelectionOcr();});
    var bulkDittoBtn = document.getElementById('ocr-bulk-ditto');
    if (bulkDittoBtn) bulkDittoBtn.addEventListener('click',function(e){e.preventDefault();bulkDitto();});
    var bulkDeleteBtn = document.getElementById('ocr-bulk-delete');
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click',function(e){e.preventDefault();bulkDelete();});
    var mergeCancelBtn = document.getElementById('ocr-merge-cancel');
    if (mergeCancelBtn) mergeCancelBtn.addEventListener('click',function(e){e.preventDefault();state.ocrSelectedIds.clear();var b=document.getElementById('ocr-merge-bar');if(b)b.style.display='none';clearOcrSelection();});

    // Global click: close popups / clear OCR selections
    document.addEventListener('click',function(e){
      if(state.suppressClickClose){state.suppressClickClose=false;return;}
      var popup=document.getElementById('ocr-popup');
      if(popup.style.display!=='none'&&!popup.contains(e.target)&&!popup._pendingRegion)closeEditPopup();
      if(!e.target.closest('#dp-viewer')&&!e.target.closest('#ocr-merge-bar'))clearOcrSelection();
      if(!e.target.closest('#dp-viewer')&&!e.target.closest('#ner-select-bar')&&!e.target.closest('#dp-ner-popup'))clearNerSelection();
      var ocrMenu=document.getElementById('dp-rerun-ocr-menu');
      if(ocrMenu&&ocrMenu.classList.contains('open')&&!e.target.closest('.dp-split-btn'))ocrMenu.classList.remove('open');
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

    // NER selection bar
    var nerApply = document.getElementById('ner-select-apply');
    if (nerApply) nerApply.addEventListener('click', function(e){
      e.preventDefault();
      var sel = document.getElementById('ner-select-type');
      nerApplyBulkLabel(sel ? sel.value : '');
    });
    var nerCancelSel = document.getElementById('ner-select-cancel');
    if (nerCancelSel) nerCancelSel.addEventListener('click', function(e){
      e.preventDefault(); clearNerSelection();
    });

    // NER entity sections (collapsible)
    document.querySelectorAll('.dp-ner-section-header').forEach(function(h){
      h.addEventListener('click', function(){
        h.parentElement.classList.toggle('collapsed');
      });
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

  /* ── divider resizing ──────────────────────────────────────── */
  var SIDE_PANEL_IDS = ['dp-text-panel', 'dp-ner-panel', 'dp-tag-panel'];
  function applySidePanelWidth() {
    SIDE_PANEL_IDS.forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.style.width = state.sidePanelWidth + 'px';
    });
  }
  function activeSidePanel() {
    var id = state.activeTab === 'label' ? 'dp-tag-panel'
           : state.activeTab === 'ner'   ? 'dp-ner-panel'
           : 'dp-text-panel';
    return document.getElementById(id);
  }
  state.sidePanelWidth = 260;
  applySidePanelWidth();
  window._viewerApplySidePanelWidth = applySidePanelWidth;

  var dividerDrag = null;
  var divider = document.getElementById('dp-divider');
  if (divider) {
    divider.addEventListener('mousedown', function(e) {
      var panel = activeSidePanel();
      if (!panel) return;
      e.preventDefault();
      dividerDrag = { startX: e.clientX, startWidth: panel.offsetWidth };
    });
  }
  document.addEventListener('mousemove', function(e) {
    if (!dividerDrag) return;
    var dx = e.clientX - dividerDrag.startX;
    state.sidePanelWidth = Math.max(120, dividerDrag.startWidth - dx);
    applySidePanelWidth();
  });
  document.addEventListener('mouseup', function(e) {
    dividerDrag = null;
  });

  /* ── keyboard ──────────────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = tag==='INPUT'||tag==='TEXTAREA'||(document.activeElement&&document.activeElement.isContentEditable);
    if (e.key==='ArrowLeft'  && !inInput && PREV_URL) { navigate(PREV_URL); return; }
    if (e.key==='ArrowRight' && !inInput && NEXT_URL) { navigate(NEXT_URL); return; }

    if (state.activeTab === 'label' && state.tagPhase === 'labeling') {
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
      if (e.key==='Escape' && state.activeTab === 'ocr') { closeEditPopup(); state.ocrSelectedIds.clear(); var bar1=document.getElementById('ocr-merge-bar'); if (bar1) bar1.style.display='none'; clearOcrSelection(); return; }
      if (e.key==='Escape' && state.activeTab === 'ner') { nerClosePopup(); clearNerSelection(); return; }
      if ((e.ctrlKey||e.metaKey)&&!inInput){
        if(e.key==='z'&&!e.shiftKey){e.preventDefault();undo();return;}
        if(e.key==='y'||(e.key==='z'&&e.shiftKey)){e.preventDefault();redo();return;}
        if(e.key==='a' && state.activeTab==='ocr'){e.preventDefault();selectAllOcrWords();return;}
      }
      if (inInput) return;
      if (state.activeTab==='ocr'){
        if(e.key==='a'){e.preventDefault();setDrawMode(!state.drawMode);return;}
        if((e.key==='Delete'||e.key==='Backspace') && state.ocrSelectedIds.size>=2){e.preventDefault();bulkDelete();return;}
      }
    }
  });
})();
