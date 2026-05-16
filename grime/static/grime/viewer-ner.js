export function createNerModule(core) {
  var state = core.state;
  var C     = core.C;
  var NER_ENTITY_LABEL = { PER: 'name', LOC: 'address', ORG: 'organization' };

  /* ── helpers ───────────────────────────────────────────────── */
  function nerEffectiveLabel(w) {
    var raw = w.corrected_label || w.ner_label;
    return raw || null;
  }

  function nerEntityType(w) {
    var lbl = nerEffectiveLabel(w);
    return lbl ? lbl.replace(/^[BI]-/, '') : null;
  }

  /* ── popup ─────────────────────────────────────────────────── */
  function nerOpenPopup(wordId) {
    state.nerPopupWordId = wordId;
    var w = core.wordById[wordId];
    if (!w) return;
    var popup = document.getElementById('dp-ner-popup');
    document.getElementById('dp-ner-word-text').textContent = w.corrected_text || w.text;
    document.getElementById('dp-ner-label-select').value = nerEffectiveLabel(w) || '';
    core.positionAtViewerEdge(popup);
  }

  function nerClosePopup() {
    document.getElementById('dp-ner-popup').style.display = 'none';
    state.nerPopupWordId = null;
  }

  /* ── selection ─────────────────────────────────────────────── */
  function clearSelection() {
    state.nerSelectedIds.clear();
    updateNerSelectBar();
    if (state.activeTab === 'ner') core.renderOverlays();
  }

  function updateNerSelectBar() {
    core.updateSelectBar('ner-select-bar', 'ner-select-label', state.nerSelectedIds.size);
    if (state.nerSelectedIds.size >= 2) {
      var sel = document.getElementById('ner-select-type');
      if (sel) {
        var counts = {};
        state.nerSelectedIds.forEach(function(id) {
          var t = nerEntityType(core.wordById[id]);
          if (t) counts[t] = (counts[t] || 0) + 1;
        });
        var best = '', bestN = 0;
        Object.keys(counts).forEach(function(k) { if (counts[k] > bestN) { best = k; bestN = counts[k]; } });
        if (best) sel.value = best;
      }
    }
  }

  function nerSelectInRect(x1, y1, x2, y2, shiftKey) {
    var s = core.getScale(), px1 = x1/s, py1 = y1/s, px2 = x2/s, py2 = y2/s;
    if (!shiftKey) state.nerSelectedIds.clear();
    core.OCR_WORDS.forEach(function(w) {
      if ((w.left+w.width) > px1 && w.left < px2 && (w.top+w.height) > py1 && w.top < py2)
        state.nerSelectedIds.add(w.id);
    });
    updateNerSelectBar();
    core.renderOverlays();
  }

  function nerApplyBulkLabel(type) {
    if (!state.nerSelectedIds.size) return;
    var ids = Array.from(state.nerSelectedIds);
    ids.sort(function(a, b) {
      var wa = core.wordById[a], wb = core.wordById[b];
      if (!wa || !wb) return 0;
      if (wa.left !== wb.left) return wa.left - wb.left;
      return wa.top - wb.top;
    });
    var requests = ids.map(function(id, idx) {
      var label = (type === 'NONE' || !type) ? 'NONE' : (idx === 0 ? 'B-' : 'I-') + type;
      return core.postJson(C.nerCorrectUrl, 'word_id=' + id + '&label=' + encodeURIComponent(label))
        .then(function(data) {
          if (data && data.ok) {
            var w = core.wordById[id];
            if (w) w.corrected_label = (label === 'NONE') ? null : label;
          }
        });
    });
    Promise.all(requests).then(function() {
      state.nerSelectedIds.clear(); updateNerSelectBar(); nerBuildEntityList(); core.renderOverlays();
    });
  }

  /* ── entity list ───────────────────────────────────────────── */
  function nerBuildEntities() {
    var ents = [];
    var sorted = core.OCR_WORDS.slice().sort(function(a, b) {
      if (a.line_num !== b.line_num) return (a.line_num||0) - (b.line_num||0);
      return (a.word_num||0) - (b.word_num||0);
    });
    var cur = null;
    sorted.forEach(function(w) {
      var raw = nerEffectiveLabel(w);
      if (!raw) { cur = null; return; }
      var type = raw.replace(/^[BI]-/, '');
      var prefix = raw.charAt(0);
      if (prefix === 'B' || !cur || cur.type !== type) { cur = { type: type, words: [w] }; ents.push(cur); }
      else { cur.words.push(w); }
    });
    return ents.map(function(e) {
      var text = e.words.map(function(w) { return w.corrected_text != null ? w.corrected_text : w.text; }).join(' ');
      return { type: e.type, text: text, wordIds: e.words.map(function(w) { return w.id; }) };
    });
  }

  function nerBuildEntityList() {
    var ents = nerBuildEntities();
    var byType = { PER: {}, LOC: {}, ORG: {} };
    ents.forEach(function(e) {
      if (!byType[e.type]) byType[e.type] = {};
      var key = e.text.trim().toLowerCase();
      if (!key) return;
      if (!byType[e.type][key]) byType[e.type][key] = { type: e.type, text: e.text, count: 0, wordIds: [] };
      byType[e.type][key].count += 1;
      byType[e.type][key].wordIds = byType[e.type][key].wordIds.concat(e.wordIds);
    });
    ['PER', 'LOC', 'ORG'].forEach(function(t) {
      var section = document.querySelector('.dp-ner-section[data-type="' + t + '"]');
      if (!section) return;
      var body    = section.querySelector('.dp-ner-section-body');
      var countEl = section.querySelector('.dp-ner-section-count');
      var items   = Object.keys(byType[t] || {}).map(function(k) { return byType[t][k]; });
      items.sort(function(a, b) { return b.count - a.count; });
      countEl.textContent = '(' + items.length + ')';
      body.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'dp-ner-entity-empty'; empty.textContent = 'No entities.'; body.appendChild(empty); return;
      }
      items.forEach(function(item) {
        var row = document.createElement('div');
        row.className = 'dp-ner-entity-row ner-' + t;
        var key = t + ':' + item.text.trim().toLowerCase();
        if (state.nerHighlightKey === key) row.classList.add('active');
        var txt = document.createElement('span'); txt.className = 'dp-ner-entity-text'; txt.textContent = item.text;
        var cnt = document.createElement('span'); cnt.className = 'dp-ner-entity-count'; cnt.textContent = item.count;
        row.appendChild(txt); row.appendChild(cnt);
        row.addEventListener('click', function() {
          state.nerHighlightKey = (state.nerHighlightKey === key) ? null : key;
          nerBuildEntityList(); core.renderOverlays();
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
    nerBuildEntities().forEach(function(e) {
      if (e.type === type && e.text.trim().toLowerCase() === key)
        e.wordIds.forEach(function(id) { ids.add(id); });
    });
    return ids;
  }

  /* ── NER suggestions (exposed via core for tag module) ─────── */
  function nerSuggestSubcomps(bbox) {
    if (!bbox) return;
    core.OCR_WORDS.forEach(function(w) {
      var entityType = nerEntityType(w);
      if (!entityType) return;
      var inRegion = w.left >= bbox.left - 4 && w.top >= bbox.top - 4 &&
                     w.left + w.width  <= bbox.left + bbox.width  + 4 &&
                     w.top  + w.height <= bbox.top  + bbox.height + 4;
      if (!inRegion) return;
      var suggLabel = NER_ENTITY_LABEL[entityType] || entityType.toLowerCase();
      if (!state.tagPendingSubcomps.find(function(s) { return s.word_id === w.id; })) {
        var text = (w.corrected_text != null ? w.corrected_text : w.text) || '';
        state.tagPendingSubcomps.push({ word_id: w.id, label: suggLabel, text: text });
      }
    });
  }

  /* ── NER run ───────────────────────────────────────────────── */
  function nerBtnLabel() {
    return core.OCR_WORDS.some(function(w) { return w.ner_label || w.corrected_label; }) ? 'Rerun NER' : 'Run NER';
  }

  function runNer() {
    if (!C.nerRerunUrl) return;
    var btn = document.getElementById('dp-rerun-ner');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    core.postJson(C.nerRerunUrl, '').then(function(data) {
      if (!data.ok) { if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); } alert(data.error || 'NER failed.'); return; }
      data.words.forEach(function(w) {
        var word = core.wordById[w.id];
        if (word) { word.ner_label = w.ner_label; word.corrected_label = w.corrected_label; }
      });
      nerBuildEntityList(); core.renderOverlays(); core.updateBadge();
      if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); }
    }).catch(function() { if (btn) { btn.disabled = false; btn.textContent = nerBtnLabel(); } });
  }

  /* ── render ────────────────────────────────────────────────── */
  function render(viewer, scale) {
    var highlightWordIds = nerHighlightWordIdSet();
    core.OCR_WORDS.forEach(function(w) {
      var entityType = nerEntityType(w);
      var className  = 'dp-ner-overlay';
      if (!entityType) className += ' ner-NONE'; else className += ' ner-' + entityType;
      if (state.nerSelectedIds.has(w.id))  className += ' selected';
      if (highlightWordIds.has(w.id)) className += ' entity-highlight';
      var div = document.createElement('div');
      div.className    = className;
      div.dataset.wordId = w.id;
      div.style.left   = Math.round(w.left   * scale) + 'px';
      div.style.top    = Math.round(w.top    * scale) + 'px';
      div.style.width  = Math.round(w.width  * scale) + 'px';
      div.style.height = Math.round(w.height * scale) + 'px';
      div.title = (nerEffectiveLabel(w) || '') + ': ' + (w.corrected_text || w.text);
      viewer.appendChild(div);
    });
  }

  /* ── mouse handlers ────────────────────────────────────────── */
  function onMousedown(e) {
    e.preventDefault();
    state.selectStart = { x: e.clientX, y: e.clientY, target: e.target };
    state.isDragging = false;
  }

  function onMousemove(e) {
    if (!state.selectStart) return;
    var dx = e.clientX - state.selectStart.x, dy = e.clientY - state.selectStart.y;
    if (!state.isDragging && Math.sqrt(dx*dx + dy*dy) > 5) { state.isDragging = true; if (!e.shiftKey) clearSelection(); }
    if (state.isDragging) {
      var vr = document.getElementById('dp-viewer').getBoundingClientRect();
      var sr = document.getElementById('dp-select-rect');
      core.updateRubberBand(sr, state.selectStart.x, state.selectStart.y, e.clientX, e.clientY, vr);
    }
  }

  function onMouseup(e) {
    if (!state.selectStart) return;
    var vr = document.getElementById('dp-viewer').getBoundingClientRect();
    if (state.isDragging) {
      nerSelectInRect(
        Math.min(state.selectStart.x, e.clientX) - vr.left, Math.min(state.selectStart.y, e.clientY) - vr.top,
        Math.max(state.selectStart.x, e.clientX) - vr.left, Math.max(state.selectStart.y, e.clientY) - vr.top,
        e.shiftKey
      );
      document.getElementById('dp-select-rect').style.display = 'none';
    } else {
      var nerEl = state.selectStart.target.closest ? state.selectStart.target.closest('.dp-ner-overlay') : null;
      if (nerEl && nerEl.dataset.wordId) {
        var nwid = parseInt(nerEl.dataset.wordId);
        if (e.shiftKey) {
          if (state.nerSelectedIds.has(nwid)) state.nerSelectedIds.delete(nwid); else state.nerSelectedIds.add(nwid);
          updateNerSelectBar(); core.renderOverlays();
        } else { state.suppressClickClose = true; clearSelection(); nerOpenPopup(nwid); }
      } else if (!e.shiftKey) { clearSelection(); }
    }
    state.isDragging = false; state.selectStart = null;
    e.stopPropagation();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { nerClosePopup(); clearSelection(); }
  }

  function onGlobalClick(e) {
    var popup = document.getElementById('dp-ner-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) nerClosePopup();
    if (!e.target.closest('#dp-viewer') && !e.target.closest('#ner-select-bar') && !e.target.closest('#dp-ner-popup')) clearSelection();
  }

  function activate() { nerBuildEntityList(); }

  /* ── setup UI ──────────────────────────────────────────────── */
  function setupUI() {
    var nerPopup = document.getElementById('dp-ner-popup');
    if (nerPopup) {
      nerPopup.addEventListener('mousedown', function(e) { e.stopPropagation(); });
      nerPopup.addEventListener('click',     function(e) { e.stopPropagation(); });
    }

    var cancelBtn = document.getElementById('dp-ner-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', nerClosePopup);

    var saveBtn = document.getElementById('dp-ner-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function() {
      if (state.nerPopupWordId == null) return;
      var label = document.getElementById('dp-ner-label-select').value || 'NONE';
      core.postJson(C.nerCorrectUrl, 'word_id=' + state.nerPopupWordId + '&label=' + encodeURIComponent(label))
        .then(function(data) {
          if (!data.ok) { alert(data.error || 'Error saving NER label.'); return; }
          var w = core.wordById[state.nerPopupWordId];
          if (w) w.corrected_label = (label === 'NONE') ? null : (label || null);
          nerClosePopup(); nerBuildEntityList(); core.renderOverlays();
        });
    });

    var nerApply = document.getElementById('ner-select-apply');
    if (nerApply) nerApply.addEventListener('click', function(e) {
      e.preventDefault(); var sel = document.getElementById('ner-select-type'); nerApplyBulkLabel(sel ? sel.value : '');
    });
    var nerCancelSel = document.getElementById('ner-select-cancel');
    if (nerCancelSel) nerCancelSel.addEventListener('click', function(e) { e.preventDefault(); clearSelection(); });

    document.querySelectorAll('.dp-ner-section-header').forEach(function(h) {
      h.addEventListener('click', function() { h.parentElement.classList.toggle('collapsed'); });
    });

    var rerunNerBtn = document.getElementById('dp-rerun-ner');
    if (rerunNerBtn) {
      rerunNerBtn.textContent = nerBtnLabel();
      rerunNerBtn.addEventListener('click', function(e) { e.preventDefault(); runNer(); });
    }

    core.nerSuggestSubcomps = nerSuggestSubcomps;
    core.nerOpenPopup       = nerOpenPopup;
  }

  return {
    render, onMousedown, onMousemove, onMouseup, onKeydown, onGlobalClick, setupUI,
    clearSelection, activate,
  };
}
