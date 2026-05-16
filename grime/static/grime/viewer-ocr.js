export function createOcrModule(core) {
  var state      = core.state;
  var C          = core.C;
  var HAS_REPAIR = C.hasRepair;

  /* ── text panel ────────────────────────────────────────────── */
  // Group OCR_WORDS into lines sorted by line_num / word_num.
  function _buildLineMap() {
    var lineMap = {};
    core.OCR_WORDS.forEach(function(w) {
      if (w.line_num == null) return;
      var key = String(w.line_num);
      if (!lineMap[key]) lineMap[key] = { l: w.line_num, words: [] };
      lineMap[key].words.push(w);
    });
    var lines = Object.values(lineMap);
    lines.sort(function(a, b) { return a.l - b.l; });
    lines.forEach(function(line) { line.words.sort(function(a, b) { return a.word_num - b.word_num; }); });
    return lines;
  }

  // Mirror ocrSelectedIds onto the .selected class of text-panel word spans.
  function syncTextPanelSelection() {
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
  }

  // Rebuild the OCR text panel from current OCR_WORDS, applying search highlights.
  function updateTextPanels() {
    var ocr = document.getElementById('dp-corrected-text');
    if (!ocr) return;
    ocr.innerHTML = '';
    var lines = _buildLineMap();
    lines.forEach(function(line) {
      var lineDiv = document.createElement('div');
      lineDiv.className = 'dp-text-line';
      line.words.filter(function(w) { return (w.text || '').trim(); })
        .forEach(function(w) {
          var wordSpan = document.createElement('span');
          wordSpan.className = 'dp-text-word';
          if (state.ocrSelectedIds.has(w.id)) wordSpan.classList.add('selected');
          if (_searchQuery && (w.text || '').toLowerCase().indexOf(_searchQuery) >= 0)
            wordSpan.classList.add('search-match');
          wordSpan.textContent = w.text;
          wordSpan.dataset.wordId = w.id;
          (function(wid) {
            wordSpan.addEventListener('click', function(e) {
              if (_textSelectionSuppressClick) { _textSelectionSuppressClick = false; return; }
              if (!e.shiftKey) state.ocrSelectedIds.clear();
              if (state.ocrSelectedIds.has(wid)) state.ocrSelectedIds.delete(wid);
              else state.ocrSelectedIds.add(wid);
              document.querySelectorAll('.ocr-word').forEach(function(el) {
                el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
              });
              updateOcrMergeBar();
              syncTextPanelSelection();
            });
          })(w.id);
          lineDiv.appendChild(wordSpan);
          lineDiv.appendChild(document.createTextNode(' '));
        });
      if (lineDiv.textContent.trim()) ocr.appendChild(lineDiv);
    });
  }

  var _searchQuery = '';
  // Filter OCR_WORDS by query, select matching words and highlight them in the text panel.
  function applyTextSearch(query) {
    _searchQuery = (query || '').trim().toLowerCase();
    var matchIds = new Set();
    if (_searchQuery) {
      core.OCR_WORDS.forEach(function(w) {
        var t = (w.text || '').toLowerCase();
        if (t.indexOf(_searchQuery) >= 0 && w.id != null) matchIds.add(w.id);
      });
    }
    var count = matchIds.size;
    var countEl = document.getElementById('dp-text-search-count');
    if (countEl) countEl.textContent = _searchQuery ? (count ? count + ' match' + (count === 1 ? '' : 'es') : 'no matches') : '';
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(el) {
      el.classList.toggle('search-match', matchIds.has(parseInt(el.dataset.wordId)));
    });
    if (_searchQuery) {
      state.ocrSelectedIds.clear();
      matchIds.forEach(function(id) { state.ocrSelectedIds.add(id); });
      document.querySelectorAll('.ocr-word').forEach(function(el) {
        el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
      });
      updateOcrMergeBar();
      var first = document.querySelector('#dp-corrected-text .dp-text-word.search-match');
      if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      state.ocrSelectedIds.clear();
      document.querySelectorAll('.ocr-word.selected').forEach(function(el) { el.classList.remove('selected'); });
      updateOcrMergeBar();
    }
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
  }

  var _textSelectionSuppressClick = false;
  // Select OCR words from a native browser text selection in the text panel.
  function onTextPanelMouseup(e) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var hitIds = [];
    document.querySelectorAll('#dp-corrected-text .dp-text-word').forEach(function(span) {
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
    syncTextPanelSelection();
    sel.removeAllRanges();
    _textSelectionSuppressClick = true;
  }

  /* ── word class + selection ────────────────────────────────── */
  // Return the CSS class string for a word overlay based on correction and confidence.
  function wordClass(w) {
    if (w.corrected_text) return 'ocr-word ' + (w.is_ditto ? 'conf-ditto' : 'corrected');
    return 'ocr-word ' + (w.conf < 60 ? 'conf-low' : w.conf < 80 ? 'conf-mid' : 'conf-high');
  }

  // Clear the OCR selection set and hide the merge bar.
  function clearSelection() {
    if (!HAS_REPAIR) return;
    state.ocrSelectedIds.clear();
    document.querySelectorAll('.ocr-word.selected').forEach(function(el) { el.classList.remove('selected'); });
    updateOcrMergeBar();
    updateTextPanels();
  }

  // Show or hide the OCR multi-select action bar based on selection size.
  function updateOcrMergeBar() {
    core.updateSelectBar('ocr-merge-bar', 'ocr-merge-label', state.ocrSelectedIds.size);
  }

  // Add all word ids to ocrSelectedIds and mark their overlays as selected.
  function selectAllOcrWords() {
    state.ocrSelectedIds.clear();
    core.OCR_WORDS.forEach(function(w) { if (w.id != null) state.ocrSelectedIds.add(w.id); });
    document.querySelectorAll('.ocr-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
    updateOcrMergeBar();
    updateTextPanels();
  }

  /* ── OCR run ───────────────────────────────────────────────── */
  // Return "Run OCR" or "Rerun OCR" depending on whether words already exist.
  function ocrBtnLabel() { return core.OCR_WORDS.length ? 'Rerun OCR' : 'Run OCR'; }

  // POST an OCR run (full page or selected words) with the given engine.
  function runOcr(engine) {
    if (!C.rerunSelectionUrl) return;
    var btn = document.getElementById('dp-rerun-ocr');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    var parts = ['engine=' + encodeURIComponent(engine || 'textract')];
    if (state.ocrSelectedIds.size)
      parts.push('word_pks=' + encodeURIComponent(Array.from(state.ocrSelectedIds).join(',')));
    core.postJson(C.rerunSelectionUrl, parts.join('&')).then(function(data) {
      if (!data.ok) { if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); } alert(data.error || 'OCR failed.'); return; }
      core.applyOcrWordDiff(data);
      state.ocrSelectedIds.clear();
      var bar = document.getElementById('ocr-merge-bar'); if (bar) bar.style.display = 'none';
      core.renderOverlays(); updateTextPanels();
      if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); }
    }).catch(function() { if (btn) { btn.disabled = false; btn.textContent = ocrBtnLabel(); } });
  }

  // POST a rerun for the currently selected words, triggered from the selection bar.
  function rerunSelectionOcr() {
    if (!C.rerunSelectionUrl || !state.ocrSelectedIds.size) return;
    var btn = document.getElementById('ocr-rerun-ocr');
    if (btn) { btn.disabled = true; btn.textContent = 'Rerunning…'; }
    var body = 'engine=textract&word_pks=' + encodeURIComponent(Array.from(state.ocrSelectedIds).join(','));
    core.postJson(C.rerunSelectionUrl, body).then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Rerun OCR'; }
      if (!data.ok) { alert(data.error || 'Rerun OCR failed.'); return; }
      core.applyOcrWordDiff(data);
      state.ocrSelectedIds.clear();
      var bar = document.getElementById('ocr-merge-bar'); if (bar) bar.style.display = 'none';
      core.renderOverlays(); updateTextPanels();
    }).catch(function() { if (btn) { btn.disabled = false; btn.textContent = 'Rerun OCR'; } });
  }

  /* ── rect selection ────────────────────────────────────────── */
  // Select all words whose bounding boxes overlap the given viewer-local rect.
  function ocrSelectInRect(x1, y1, x2, y2, shiftKey) {
    var s = core.getScale(), px1 = x1/s, py1 = y1/s, px2 = x2/s, py2 = y2/s;
    if (!shiftKey) state.ocrSelectedIds.clear();
    core.OCR_WORDS.forEach(function(w) {
      if ((w.left+w.width) > px1 && w.left < px2 && (w.top+w.height) > py1 && w.top < py2)
        state.ocrSelectedIds.add(w.id);
    });
    document.querySelectorAll('.ocr-word').forEach(function(el) {
      el.classList.toggle('selected', state.ocrSelectedIds.has(parseInt(el.dataset.wordId)));
    });
    updateOcrMergeBar();
    updateTextPanels();
  }

  /* ── undo / redo ───────────────────────────────────────────── */
  // Push an undo entry and clear the redo stack.
  function recordUndo(e) { state.undoStack.push(e); state.redoStack = []; }

  // DELETE the word with id, remove it from OCR_WORDS/wordById, and call cb when done.
  function _deleteWordById(id, cb) {
    core.postJson(C.deleteUrl, 'word_pk=' + encodeURIComponent(id)).then(function(data) {
      if (!data.ok) return;
      core.OCR_WORDS = core.OCR_WORDS.filter(function(w) { return w.id !== data.deleted_id; });
      delete core.wordById[data.deleted_id];
      var el = document.querySelector("[data-word-id='" + data.deleted_id + "']");
      if (el) el.remove();
      updateTextPanels();
      if (cb) cb();
    });
  }

  // POST a new word region and add it to OCR_WORDS/wordById, calling cb with the new word.
  function _addWordFromData(w, cb) {
    var body = 'left=' + w.left + '&top=' + w.top + '&width=' + w.width + '&height=' + w.height +
               '&corrected_text=' + encodeURIComponent(w.corrected_text || w.text || '');
    core.postJson(C.addWordUrl, body).then(function(data) {
      if (!data.ok) return;
      core.OCR_WORDS.push(data.word); core.wordById[data.word.id] = data.word;
      core.renderOverlays(); updateTextPanels();
      if (cb) cb(data.word);
    });
  }

  // Pop the top entry from `from`, apply its inverse, and push the inverse onto `to`.
  function _applyHistory(from, to) {
    if (!from.length) return;
    var e = from.pop();
    if (e.type === 'correct') {
      var w = core.wordById[e.wordId]; if (!w) return;
      var el = document.querySelector("[data-word-id='" + e.wordId + "']");
      to.push({ type: 'correct', wordId: e.wordId, prev: e.next, next: e.prev });
      postCorrection(w, el, e.prev, true);
    } else if (e.type === 'add') {
      var s = Object.assign({}, core.wordById[e.wordId]);
      to.push({ type: 'delete', wordData: s });
      _deleteWordById(e.wordId);
    } else if (e.type === 'delete') {
      _addWordFromData(e.wordData, function(nw) { to.push({ type: 'add', wordId: nw.id }); });
    }
  }

  // Undo the last OCR edit.
  function undo() { _applyHistory(state.undoStack, state.redoStack); }
  // Redo the last undone OCR edit.
  function redo() { _applyHistory(state.redoStack, state.undoStack); }

  /* ── edit popup ────────────────────────────────────────────── */
  // Open the single-word correction popup for word/el.
  function openEditPopup(word, el) {
    if (!HAS_REPAIR) return;
    var popup = document.getElementById('ocr-popup');
    var mergeBar = document.getElementById('ocr-merge-bar'); if (mergeBar) mergeBar.style.display = 'none';
    state.currentWord = word; state.currentEl = el;
    document.getElementById('ocr-popup-original').textContent = 'Original: ' + word.text;
    document.getElementById('ocr-popup-input').value = word.corrected_text || '';
    core.positionAtViewerEdge(popup);
    var confirmBtn = document.getElementById('ocr-popup-confirm'); if (confirmBtn) confirmBtn.style.display = '';
    var delBtn    = document.getElementById('ocr-popup-delete');  if (delBtn)    delBtn.style.display    = '';
    var dittoBtn  = document.getElementById('ocr-popup-ditto');   if (dittoBtn)  dittoBtn.style.display   = '';
    document.getElementById('ocr-popup-input').focus();
    document.getElementById('ocr-popup-input').select();
  }

  // Hide the correction popup and clear currentWord/currentEl.
  function closeEditPopup() {
    var popup = document.getElementById('ocr-popup');
    popup.style.display = 'none'; popup._pendingRegion = null;
    state.currentWord = null; state.currentEl = null;
    if (state.ocrSelectedIds.size >= 2) updateOcrMergeBar();
  }

  // POST corrected_text for word, update the overlay class/title, and record an undo entry.
  function postCorrection(word, el, text, skipUndo) {
    if (!HAS_REPAIR) return;
    var prev = word.corrected_text;
    if (!skipUndo) recordUndo({ type: 'correct', wordId: word.id, prev: prev, next: text });
    core.postJson(C.correctUrl, 'word_pk=' + encodeURIComponent(word.id) + '&corrected_text=' + encodeURIComponent(text))
      .then(function(data) {
        if (!data.ok) return;
        word.corrected_text = data.corrected_text || null;
        if (el) {
          el.className = wordClass(word) + (state.ocrSelectedIds.has(word.id) ? ' selected' : '');
          el.title = (word.corrected_text ? '✓ ' + word.corrected_text : word.text) + ' (' + Math.round(word.conf) + '%)';
        }
        updateTextPanels();
      });
  }

  // Save the popup input as a correction (or create a new word region if pending).
  function saveEdit() {
    var input = document.getElementById('ocr-popup-input');
    var popup = document.getElementById('ocr-popup');
    var pending = popup._pendingRegion;
    if (pending) {
      var t = input.value.trim(); popup._pendingRegion = null; closeEditPopup(); setDrawMode(false);
      if (t) saveAddRegion(pending, t); else document.getElementById('dp-draw-rect').style.display = 'none';
      return;
    }
    if (!state.currentWord) return;
    postCorrection(state.currentWord, state.currentEl, input.value.trim());
    closeEditPopup();
  }

  // Confirm the word's existing text as its corrected_text without editing.
  function confirmEdit() {
    if (!state.currentWord) return;
    postCorrection(state.currentWord, state.currentEl, state.currentWord.text);
    closeEditPopup();
  }

  // Delete the current word, recording an undo entry.
  function deleteWord() {
    if (!state.currentWord) return;
    var snap = Object.assign({}, state.currentWord), id = state.currentWord.id;
    closeEditPopup();
    _deleteWordById(id, function() { recordUndo({ type: 'delete', wordData: snap }); });
  }

  /* ── ditto ─────────────────────────────────────────────────── */
  // Apply a server ditto response to the marked word and its resolved siblings.
  function _applyDittoResult(word, el, data) {
    word.text = '"'; word.corrected_text = null; word.is_ditto = false;
    if (el) {
      el.className = wordClass(word) + (state.ocrSelectedIds.has(word.id) ? ' selected' : '');
      el.title = word.text + ' (' + Math.round(word.conf) + '%)';
    }
    data.updated.forEach(function(u) {
      var w = core.wordById[u.id];
      if (w) {
        w.corrected_text = u.corrected_text; w.is_ditto = true;
        var e = document.querySelector('[data-word-id="' + u.id + '"]');
        if (e) { e.className = wordClass(w) + (state.ocrSelectedIds.has(w.id) ? ' selected' : ''); e.title = '✓ ' + u.corrected_text + ' (' + Math.round(w.conf) + '%)'; }
      }
    });
    core.renderOverlays(); updateTextPanels();
  }

  // Mark the current word (or a pending drawn region) as a ditto mark.
  function markWordAsDitto() {
    if (!C.markAsDittoUrl) return;
    var popup = document.getElementById('ocr-popup');
    var pending = popup._pendingRegion;
    if (pending) {
      popup._pendingRegion = null; closeEditPopup(); setDrawMode(false);
      var addBody = 'left=' + pending.left + '&top=' + pending.top + '&width=' + pending.width + '&height=' + pending.height + '&corrected_text=';
      core.postJson(C.addWordUrl, addBody).then(function(data) {
        if (!data.ok) return;
        var word = data.word;
        core.OCR_WORDS.push(word); core.wordById[word.id] = word;
        recordUndo({ type: 'add', wordId: word.id }); core.renderOverlays();
        core.postJson(C.markAsDittoUrl, 'word_pk=' + encodeURIComponent(word.id)).then(function(data2) {
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
    core.postJson(C.markAsDittoUrl, 'word_pk=' + encodeURIComponent(word.id)).then(function(data) {
      if (!data.ok) return;
      _applyDittoResult(word, el, data);
    });
  }

  /* ── bulk operations ───────────────────────────────────────── */
  // Confirm all unreviewed words on the page in one request.
  function confirmAll() {
    var btn = document.getElementById('dp-confirm-all');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Confirming…';
    core.postJson(C.confirmAllUrl, '').then(function(data) {
      if (!data.ok) { btn.disabled = false; btn.textContent = 'Confirm all'; return; }
      data.updated.forEach(function(u) { var w = core.wordById[u.id]; if (w) w.corrected_text = u.corrected_text; });
      core.renderOverlays(); updateTextPanels();
      btn.textContent = 'Confirmed (' + data.updated.length + ')';
      setTimeout(function() { btn.disabled = false; btn.textContent = 'Confirm all'; }, 2000);
    }).catch(function() { btn.disabled = false; btn.textContent = 'Confirm all'; });
  }

  // Mark all selected words as ditto marks in one request.
  function bulkDitto() {
    if (!state.ocrSelectedIds.size || !C.bulkDittoUrl) return;
    core.postJson(C.bulkDittoUrl, 'word_pks=' + encodeURIComponent(Array.from(state.ocrSelectedIds).join(','))).then(function(data) {
      if (!data.ok) return;
      data.marked_pks.forEach(function(id) { var w = core.wordById[id]; if (w) { w.text = '"'; w.corrected_text = null; w.is_ditto = false; } });
      data.updated.forEach(function(u) { var w = core.wordById[u.id]; if (w) { w.corrected_text = u.corrected_text; w.is_ditto = true; } });
      state.ocrSelectedIds.clear();
      document.getElementById('ocr-merge-bar').style.display = 'none';
      core.renderOverlays(); updateTextPanels(); updateOcrMergeBar();
    });
  }

  // Delete all selected words after a confirmation prompt.
  function bulkDelete() {
    if (!state.ocrSelectedIds.size || !C.bulkDeleteUrl) return;
    var pks = Array.from(state.ocrSelectedIds);
    if (!confirm('Delete ' + pks.length + ' selected word' + (pks.length === 1 ? '' : 's') + '?')) return;
    core.postJson(C.bulkDeleteUrl, 'word_pks=' + encodeURIComponent(pks.join(','))).then(function(data) {
      if (!data.ok) return;
      var del = new Set(data.deleted_ids);
      core.OCR_WORDS = core.OCR_WORDS.filter(function(w) { return !del.has(w.id); });
      data.deleted_ids.forEach(function(id) { delete core.wordById[id]; });
      state.ocrSelectedIds.clear();
      document.getElementById('ocr-merge-bar').style.display = 'none';
      core.renderOverlays(); updateTextPanels(); updateOcrMergeBar();
    });
  }

  /* ── draw mode ─────────────────────────────────────────────── */
  // Toggle visibility of all OCR word boxes.
  function toggleBoxes() {
    state.boxesHidden = !state.boxesHidden;
    document.getElementById('dp-viewer').classList.toggle('hide-boxes', state.boxesHidden);
    document.getElementById('dp-boxes-toggle').textContent = state.boxesHidden ? 'Show boxes' : 'Hide boxes';
  }

  // Enter or exit the draw-a-new-region mode, updating the cursor and button state.
  function setDrawMode(active) {
    state.drawMode = active;
    var v = document.getElementById('dp-viewer'), btn = document.getElementById('dp-draw-toggle');
    if (active) { v.classList.add('draw-mode'); btn.textContent = 'Cancel draw'; btn.style.background = '#e67e00'; btn.style.color = '#fff'; }
    else { v.classList.remove('draw-mode'); btn.textContent = 'Add region (a)'; btn.style.background = ''; btn.style.color = ''; document.getElementById('dp-draw-rect').style.display = 'none'; state.drawOrigin = null; }
  }

  // POST a new word region from the drawn rect and add it to OCR_WORDS.
  function saveAddRegion(pending, text) {
    var body = 'left=' + pending.left + '&top=' + pending.top + '&width=' + pending.width + '&height=' + pending.height + '&corrected_text=' + encodeURIComponent(text);
    core.postJson(C.addWordUrl, body).then(function(data) {
      if (!data.ok) return;
      core.OCR_WORDS.push(data.word); core.wordById[data.word.id] = data.word;
      recordUndo({ type: 'add', wordId: data.word.id });
      core.renderOverlays(); updateTextPanels();
      document.getElementById('dp-draw-rect').style.display = 'none';
    });
  }

  /* ── render ────────────────────────────────────────────────── */
  // Draw one overlay div per OCR word, coloured by confidence / correction state.
  function render(viewer, scale) {
    core.OCR_WORDS.forEach(function(w) {
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

  /* ── mouse handlers ────────────────────────────────────────── */
  // Begin a draw gesture or a drag-select depending on the current mode.
  function onMousedown(e) {
    if (state.drawMode) {
      e.preventDefault(); state.drawOrigin = core.viewerOffset(e);
      var dr = document.getElementById('dp-draw-rect');
      dr.style.left = state.drawOrigin.x + 'px'; dr.style.top = state.drawOrigin.y + 'px';
      dr.style.width = '0'; dr.style.height = '0'; dr.style.display = 'block';
    } else {
      e.preventDefault(); state.selectStart = { x: e.clientX, y: e.clientY, target: e.target }; state.isDragging = false;
    }
  }

  // Update the draw rect or the rubber-band selection rect while the mouse moves.
  function onMousemove(e) {
    if (state.drawMode) {
      if (!state.drawOrigin) return;
      var pos = core.viewerOffset(e), dr = document.getElementById('dp-draw-rect');
      dr.style.left = Math.min(pos.x, state.drawOrigin.x) + 'px';
      dr.style.top  = Math.min(pos.y, state.drawOrigin.y) + 'px';
      dr.style.width  = Math.abs(pos.x - state.drawOrigin.x) + 'px';
      dr.style.height = Math.abs(pos.y - state.drawOrigin.y) + 'px';
    } else {
      if (!state.selectStart) return;
      var dx = e.clientX - state.selectStart.x, dy = e.clientY - state.selectStart.y;
      if (!state.isDragging && Math.sqrt(dx*dx + dy*dy) > 5) { state.isDragging = true; if (!e.shiftKey) clearSelection(); }
      if (state.isDragging) {
        var vr = document.getElementById('dp-viewer').getBoundingClientRect();
        var sr = document.getElementById('dp-select-rect');
        core.updateRubberBand(sr, state.selectStart.x, state.selectStart.y, e.clientX, e.clientY, vr);
      }
    }
  }

  // Finalise a draw or selection gesture, or open the popup for a single-word click.
  function onMouseup(e) {
    if (state.drawMode) {
      if (!state.drawOrigin) return;
      var pos = core.viewerOffset(e), scale = core.getScale();
      var dx = Math.min(pos.x, state.drawOrigin.x), dy = Math.min(pos.y, state.drawOrigin.y);
      var dw = Math.abs(pos.x - state.drawOrigin.x), dh = Math.abs(pos.y - state.drawOrigin.y);
      state.drawOrigin = null;
      if (dw < 4 || dh < 4) { setDrawMode(false); return; }
      var pending = { left: Math.round(dx/scale), top: Math.round(dy/scale), width: Math.round(dw/scale), height: Math.round(dh/scale) };
      state.currentWord = null; state.currentEl = null;
      var popup = document.getElementById('ocr-popup');
      document.getElementById('ocr-popup-original').textContent = 'New region';
      document.getElementById('ocr-popup-input').value = '';
      document.getElementById('ocr-popup-confirm').style.display = 'none';
      document.getElementById('ocr-popup-delete').style.display = 'none';
      core.positionAtViewerEdge(popup);
      popup._pendingRegion = pending;
      document.getElementById('ocr-popup-input').focus();
    } else {
      if (!state.selectStart) return;
      if (state.isDragging) {
        var vr = document.getElementById('dp-viewer').getBoundingClientRect();
        ocrSelectInRect(
          Math.min(state.selectStart.x, e.clientX) - vr.left, Math.min(state.selectStart.y, e.clientY) - vr.top,
          Math.max(state.selectStart.x, e.clientX) - vr.left, Math.max(state.selectStart.y, e.clientY) - vr.top,
          e.shiftKey
        );
        document.getElementById('dp-select-rect').style.display = 'none';
      } else {
        var target = state.selectStart.target;
        var wordEl = target.closest ? target.closest('.ocr-word') : (target.classList.contains('ocr-word') ? target : null);
        if (wordEl && wordEl.dataset.wordId) {
          var wid = parseInt(wordEl.dataset.wordId), word = core.wordById[wid];
          if (word) {
            if (e.shiftKey) {
              if (state.ocrSelectedIds.has(wid)) state.ocrSelectedIds.delete(wid); else state.ocrSelectedIds.add(wid);
              wordEl.classList.toggle('selected', state.ocrSelectedIds.has(wid));
              updateOcrMergeBar(); updateTextPanels();
            } else { state.suppressClickClose = true; openEditPopup(word, wordEl); }
          }
        } else if (!e.shiftKey) { clearSelection(); }
      }
      state.isDragging = false; state.selectStart = null;
    }
    e.stopPropagation();
  }

  /* ── keyboard + global click ───────────────────────────────── */
  // Handle Escape, Ctrl+A, 'a' (draw mode), and Delete for bulk deletion.
  function onKeydown(e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
    if (!HAS_REPAIR) return;
    if (e.key === 'Escape') {
      closeEditPopup(); state.ocrSelectedIds.clear();
      var bar = document.getElementById('ocr-merge-bar'); if (bar) bar.style.display = 'none';
      clearSelection(); return;
    }
    if ((e.ctrlKey || e.metaKey) && !inInput) {
      if (e.key === 'a') { e.preventDefault(); selectAllOcrWords(); return; }
    }
    if (inInput) return;
    if (e.key === 'a') { e.preventDefault(); setDrawMode(!state.drawMode); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.ocrSelectedIds.size >= 2) { e.preventDefault(); bulkDelete(); return; }
  }

  // Close the popup or clear selection when clicking outside the viewer / popup.
  function onGlobalClick(e) {
    var popup = document.getElementById('ocr-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target) && !popup._pendingRegion) closeEditPopup();
    if (!e.target.closest('#dp-viewer') && !e.target.closest('#ocr-merge-bar') && !e.target.closest('#dp-text-panel')) clearSelection();
  }

  /* ── setup UI ──────────────────────────────────────────────── */
  // Attach all OCR DOM event listeners and register undo/redo hooks with core.
  function setupUI() {
    var confirmAllBtn = document.getElementById('dp-confirm-all');
    if (confirmAllBtn) confirmAllBtn.addEventListener('click', function(e) { e.preventDefault(); confirmAll(); });
    var boxesBtn = document.getElementById('dp-boxes-toggle');
    if (boxesBtn) boxesBtn.addEventListener('click', function(e) { e.preventDefault(); toggleBoxes(); });
    var drawBtn = document.getElementById('dp-draw-toggle');
    if (drawBtn) drawBtn.addEventListener('click', function(e) { e.preventDefault(); setDrawMode(!state.drawMode); });

    var reclusterBtn = document.getElementById('dp-recluster');
    if (reclusterBtn && C.reclusterUrl) reclusterBtn.addEventListener('click', function(e) {
      e.preventDefault(); var btn = this; btn.disabled = true; btn.textContent = 'Re-clustering…';
      core.postJson(C.reclusterUrl, '').then(function(data) {
        btn.disabled = false; btn.textContent = 'Re-cluster';
        if (!data.ok) return;
        core.OCR_WORDS = data.updated;
        var wb = core.wordById; Object.keys(wb).forEach(function(k) { delete wb[k]; });
        core.OCR_WORDS.forEach(function(w) { wb[w.id] = w; });
        core.renderOverlays(); updateTextPanels();
      }).catch(function() { btn.disabled = false; btn.textContent = 'Re-cluster'; });
    });

    var resolveDittosBtn = document.getElementById('dp-resolve-dittos');
    if (resolveDittosBtn && C.resolveDittosUrl) resolveDittosBtn.addEventListener('click', function(e) {
      e.preventDefault(); var btn = this; btn.disabled = true; btn.textContent = 'Resolving…';
      core.postJson(C.resolveDittosUrl, '').then(function(data) {
        btn.disabled = false; btn.textContent = 'Resolve dittos';
        if (!data.ok) return;
        data.updated.forEach(function(u) { var w = core.wordById[u.id]; if (w) w.corrected_text = u.corrected_text; });
        core.renderOverlays(); updateTextPanels();
      }).catch(function() { btn.disabled = false; btn.textContent = 'Resolve dittos'; });
    });

    var clearWordsBtn = document.getElementById('dp-clear-words');
    if (clearWordsBtn && C.clearWordsUrl) clearWordsBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (!confirm('Delete all ' + core.OCR_WORDS.length + ' words on this page? This cannot be undone.')) return;
      var btn = this; btn.disabled = true;
      core.postJson(C.clearWordsUrl, '').then(function(data) {
        btn.disabled = false;
        if (!data.ok) return;
        core.OCR_WORDS = [];
        var wb = core.wordById; Object.keys(wb).forEach(function(k) { delete wb[k]; });
        core.renderOverlays(); updateTextPanels();
      }).catch(function() { btn.disabled = false; });
    });

    var rerunOcrBtn   = document.getElementById('dp-rerun-ocr');
    var rerunCaretBtn = document.getElementById('dp-rerun-ocr-caret');
    var rerunMenu     = document.getElementById('dp-rerun-ocr-menu');
    if (rerunOcrBtn) {
      rerunOcrBtn.textContent = ocrBtnLabel();
      rerunOcrBtn.addEventListener('click', function(e) { e.preventDefault(); runOcr(state.ocrEngine || 'textract'); });
    }
    if (rerunCaretBtn && rerunMenu) {
      rerunCaretBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); rerunMenu.classList.toggle('open'); });
      rerunMenu.querySelectorAll('[data-engine]').forEach(function(item) {
        item.addEventListener('click', function(e) {
          e.preventDefault(); state.ocrEngine = item.dataset.engine;
          rerunMenu.querySelectorAll('[data-engine]').forEach(function(i) { i.classList.toggle('active', i === item); });
          rerunMenu.classList.remove('open'); runOcr(state.ocrEngine);
        });
      });
    }

    var searchInput = document.getElementById('dp-text-search');
    var searchClear = document.getElementById('dp-text-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        var q = this.value; if (searchClear) searchClear.style.display = q ? '' : 'none'; applyTextSearch(q);
      });
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { this.value = ''; if (searchClear) searchClear.style.display = 'none'; applyTextSearch(''); }
      });
    }
    if (searchClear) searchClear.addEventListener('click', function() {
      if (searchInput) { searchInput.value = ''; searchInput.focus(); } searchClear.style.display = 'none'; applyTextSearch('');
    });

    var correctedText = document.getElementById('dp-corrected-text');
    if (correctedText) correctedText.addEventListener('mouseup', onTextPanelMouseup);

    var ocpConfirm = document.getElementById('ocr-popup-confirm');
    if (ocpConfirm) ocpConfirm.addEventListener('click', function(e) { e.preventDefault(); confirmEdit(); });
    var ocpDitto = document.getElementById('ocr-popup-ditto');
    if (ocpDitto) ocpDitto.addEventListener('click', function(e) { e.preventDefault(); markWordAsDitto(); });
    var ocpDelete = document.getElementById('ocr-popup-delete');
    if (ocpDelete) ocpDelete.addEventListener('click', function(e) { e.preventDefault(); deleteWord(); });
    var ocpCancel = document.getElementById('ocr-popup-cancel');
    if (ocpCancel) ocpCancel.addEventListener('click', function(e) { e.preventDefault(); closeEditPopup(); if (state.drawMode) setDrawMode(false); });
    var ocpInput = document.getElementById('ocr-popup-input');
    if (ocpInput) ocpInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault(); var p = document.getElementById('ocr-popup');
        if (p._pendingRegion) { saveEdit(); return; }
        e.target.value.trim() === '' ? confirmEdit() : saveEdit();
      }
      if (e.key === 'Escape') { e.preventDefault(); closeEditPopup(); if (state.drawMode) setDrawMode(false); }
    });

    var rerunBtn = document.getElementById('ocr-rerun-ocr');
    if (rerunBtn) rerunBtn.addEventListener('click', function(e) { e.preventDefault(); rerunSelectionOcr(); });
    var bulkDittoBtn = document.getElementById('ocr-bulk-ditto');
    if (bulkDittoBtn) bulkDittoBtn.addEventListener('click', function(e) { e.preventDefault(); bulkDitto(); });
    var bulkDeleteBtn = document.getElementById('ocr-bulk-delete');
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', function(e) { e.preventDefault(); bulkDelete(); });
    var mergeCancelBtn = document.getElementById('ocr-merge-cancel');
    if (mergeCancelBtn) mergeCancelBtn.addEventListener('click', function(e) {
      e.preventDefault(); state.ocrSelectedIds.clear();
      var b = document.getElementById('ocr-merge-bar'); if (b) b.style.display = 'none'; clearSelection();
    });

    var dppSave = document.getElementById('dpp-save');
    if (dppSave) dppSave.addEventListener('click', function(e) { e.preventDefault(); if (typeof savePersonModal === 'function') savePersonModal(); });
    var dppCancel = document.getElementById('dpp-cancel');
    if (dppCancel) dppCancel.addEventListener('click', function(e) { e.preventDefault(); if (typeof closePersonModal === 'function') closePersonModal(); });
    var personBackdrop = document.getElementById('dp-person-backdrop');
    if (personBackdrop) personBackdrop.addEventListener('click', function(e) { if (e.target === this && typeof closePersonModal === 'function') closePersonModal(); });
    var personModal = document.getElementById('dp-person-modal');
    if (personModal) personModal.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); if (typeof savePersonModal === 'function') savePersonModal(); }
      if (e.key === 'Escape') { e.preventDefault(); if (typeof closePersonModal === 'function') closePersonModal(); }
    });

    core.setHook('undo', undo);
    core.setHook('redo', redo);
  }

  return {
    render, onMousedown, onMousemove, onMouseup, onKeydown, onGlobalClick, setupUI,
    clearSelection,
    updateTextPanels,
  };
}
