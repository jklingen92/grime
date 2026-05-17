export function createNerModule(core) {
  var state = core.state;
  var C     = core.C;
  var NER_ENTITY_LABEL = { PER: 'name', LOC: 'address', ORG: 'organization' };

  /* ── helpers ───────────────────────────────────────────────── */
  // Return the active NER label for a word: corrected_label if set, else ner_label (mirrors Word.label).
  function wordLabel(w) {
    return w.corrected_label || w.ner_label || null;
  }

  // Return the BIO-stripped entity type (PER/LOC/ORG) or null if the word has no label.
  function nerEntityType(w) {
    var lbl = wordLabel(w);
    return lbl ? lbl.replace(/^[BI]-/, '') : null;
  }

  /* ── popup ─────────────────────────────────────────────────── */
  // Open the NER edit popup for one or more word IDs (array or single id).
  function nerOpenPopup(wordIds) {
    if (!Array.isArray(wordIds)) wordIds = [wordIds];
    state.nerPopupWordIds = wordIds;
    var words = wordIds.map(function(id) { return core.wordById[id]; }).filter(Boolean);
    if (!words.length) return;
    var popup = document.getElementById('dp-ner-popup');
    document.getElementById('dp-ner-word-text').textContent = words.map(function(w) { return w.text; }).join(' ');
    var firstLabel = wordLabel(words[0]);
    var entityType = firstLabel ? firstLabel.replace(/^[BI]-/, '') : '';
    document.getElementById('dp-ner-label-select').value = entityType;
    core.positionAtViewerEdge(popup);
  }

  // Hide the NER popup and clear the pending word ids.
  function nerClosePopup() {
    document.getElementById('dp-ner-popup').style.display = 'none';
    state.nerPopupWordIds = [];
  }

  /* ── selection ─────────────────────────────────────────────── */
  // Clear the NER word selection set and hide the selection bar.
  function clearSelection() {
    state.nerSelectedIds.clear();
    updateNerSelectBar();
    if (state.activeTab === 'ner') core.renderOverlays();
  }

  // Sync the NER selection bar visibility and count label; pre-fill the entity type dropdown.
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

  // Add all words inside the given viewer-local rect to the NER selection.
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

  // POST corrected_label for each selected word in document order (first → B-, rest → I-).
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
  // Build a flat list of entity spans from OCR_WORDS, respecting BIO boundaries.
  function nerBuildEntities() {
    var ents = [];
    var sorted = core.OCR_WORDS.slice().sort(function(a, b) {
      if (a.line_num !== b.line_num) return (a.line_num||0) - (b.line_num||0);
      return (a.word_num||0) - (b.word_num||0);
    });
    var cur = null;
    sorted.forEach(function(w) {
      var raw = wordLabel(w);
      if (!raw) { cur = null; return; }
      var type = raw.replace(/^[BI]-/, '');
      var prefix = raw.charAt(0);
      if (prefix === 'B' || !cur || cur.type !== type) { cur = { type: type, words: [w] }; ents.push(cur); }
      else { cur.words.push(w); }
    });
    return ents.map(function(e) {
      var text = e.words.map(function(w) { return w.text; }).join(' ');
      return { type: e.type, text: text, wordIds: e.words.map(function(w) { return w.id; }) };
    });
  }

  // Rebuild the entity list sidebar, grouped by type and deduplicated by display text.
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

  // Return the Set of word ids that match the currently highlighted entity key.
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
  // Push NER-labelled words inside bbox into state.tagPendingSubcomps as subcomp suggestions.
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
        state.tagPendingSubcomps.push({ word_id: w.id, label: suggLabel, text: w.text || '' });
      }
    });
  }

  /* ── NER run ───────────────────────────────────────────────── */
  // Return the appropriate button label depending on whether NER data already exists.
  function nerBtnLabel() {
    return core.OCR_WORDS.some(function(w) { return w.ner_label || w.corrected_label; }) ? 'Rerun NER' : 'Run NER';
  }

  // POST a NER rerun request and update word labels in place.
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
  // Draw grouped overlay divs: one per same-entity same-line run; individual divs for unlabeled words.
  function render(viewer, scale) {
    var highlightWordIds = nerHighlightWordIdSet();
    var renderedIds = new Set();

    nerBuildEntities().forEach(function(entity) {
      var byLine = {};
      entity.wordIds.forEach(function(id) {
        var w = core.wordById[id];
        if (!w) return;
        var ln = w.line_num != null ? w.line_num : 0;
        if (!byLine[ln]) byLine[ln] = [];
        byLine[ln].push(w);
      });
      Object.keys(byLine).forEach(function(ln) {
        var lineWords = byLine[ln];
        var lineIds   = lineWords.map(function(w) { return w.id; });
        lineIds.forEach(function(id) { renderedIds.add(id); });
        var left   = Math.min.apply(null, lineWords.map(function(w) { return w.left; }));
        var top    = Math.min.apply(null, lineWords.map(function(w) { return w.top; }));
        var right  = Math.max.apply(null, lineWords.map(function(w) { return w.left + w.width; }));
        var bottom = Math.max.apply(null, lineWords.map(function(w) { return w.top + w.height; }));
        var isSel  = lineIds.some(function(id) { return state.nerSelectedIds.has(id); });
        var isHigh = lineIds.some(function(id) { return highlightWordIds.has(id); });
        var className = 'dp-ner-overlay ner-' + entity.type;
        if (isSel)  className += ' selected';
        if (isHigh) className += ' entity-highlight';
        var div = document.createElement('div');
        div.className       = className;
        div.dataset.wordIds = lineIds.join(',');
        div.style.left      = Math.round(left   * scale) + 'px';
        div.style.top       = Math.round(top    * scale) + 'px';
        div.style.width     = Math.round((right - left)  * scale) + 'px';
        div.style.height    = Math.round((bottom - top)  * scale) + 'px';
        div.title = entity.type + ': ' + lineWords.map(function(w) { return w.text; }).join(' ');
        viewer.appendChild(div);
      });
    });

    // Unlabeled words get their own individual boxes.
    core.OCR_WORDS.forEach(function(w) {
      if (renderedIds.has(w.id)) return;
      var className = 'dp-ner-overlay ner-NONE';
      if (state.nerSelectedIds.has(w.id))  className += ' selected';
      if (highlightWordIds.has(w.id)) className += ' entity-highlight';
      var div = document.createElement('div');
      div.className       = className;
      div.dataset.wordIds = String(w.id);
      div.style.left   = Math.round(w.left   * scale) + 'px';
      div.style.top    = Math.round(w.top    * scale) + 'px';
      div.style.width  = Math.round(w.width  * scale) + 'px';
      div.style.height = Math.round(w.height * scale) + 'px';
      div.title = w.text;
      viewer.appendChild(div);
    });
  }

  /* ── mouse handlers ────────────────────────────────────────── */
  // Begin a potential drag-select or single-word click.
  function onMousedown(e) {
    e.preventDefault();
    state.selectStart = { x: e.clientX, y: e.clientY, target: e.target };
    state.isDragging = false;
  }

  // Draw the rubber-band rect while dragging.
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

  // Finish a drag-select or dispatch a single-word click/shift-click.
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
      if (nerEl && nerEl.dataset.wordIds) {
        var wordIds = nerEl.dataset.wordIds.split(',').map(Number);
        if (e.shiftKey) {
          var allSel = wordIds.every(function(id) { return state.nerSelectedIds.has(id); });
          wordIds.forEach(function(id) { if (allSel) state.nerSelectedIds.delete(id); else state.nerSelectedIds.add(id); });
          updateNerSelectBar(); core.renderOverlays();
        } else { state.suppressClickClose = true; clearSelection(); nerOpenPopup(wordIds); }
      } else if (!e.shiftKey) { clearSelection(); }
    }
    state.isDragging = false; state.selectStart = null;
    e.stopPropagation();
  }

  // Close the popup and clear selection on Escape.
  function onKeydown(e) {
    if (e.key === 'Escape') { nerClosePopup(); clearSelection(); }
  }

  // Close the popup or clear selection when clicking outside the relevant elements.
  function onGlobalClick(e) {
    var popup = document.getElementById('dp-ner-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) nerClosePopup();
    if (!e.target.closest('#dp-viewer') && !e.target.closest('#ner-select-bar') && !e.target.closest('#dp-ner-popup')) clearSelection();
  }

  // Called when the NER tab becomes active; rebuild the entity list.
  function activate() { nerBuildEntityList(); }

  /* ── setup UI ──────────────────────────────────────────────── */
  // Attach all NER DOM event listeners and expose NER helpers on core for the tag module.
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
      var ids = state.nerPopupWordIds;
      if (!ids || !ids.length) return;
      var entityType = document.getElementById('dp-ner-label-select').value;
      if (!entityType) return;
      var requests = ids.map(function(id, idx) {
        var label = (idx === 0 ? 'B-' : 'I-') + entityType;
        return core.postJson(C.nerCorrectUrl, 'word_id=' + id + '&label=' + encodeURIComponent(label))
          .then(function(data) {
            if (data && data.ok) { var w = core.wordById[id]; if (w) w.corrected_label = label; }
          });
      });
      Promise.all(requests).then(function() { nerClosePopup(); nerBuildEntityList(); core.renderOverlays(); });
    });

    var deleteBtn = document.getElementById('dp-ner-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', function() {
      var ids = state.nerPopupWordIds;
      if (!ids || !ids.length) return;
      var requests = ids.map(function(id) {
        return core.postJson(C.nerCorrectUrl, 'word_id=' + id + '&label=NONE')
          .then(function(data) {
            if (data && data.ok) { var w = core.wordById[id]; if (w) w.corrected_label = null; }
          });
      });
      Promise.all(requests).then(function() { nerClosePopup(); nerBuildEntityList(); core.renderOverlays(); });
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
