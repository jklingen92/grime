// Pure derived-state helpers. Components call these inside useMemo with
// the appropriate state slices as inputs.

const NER_ENTITY_LABEL = { PER: 'name', LOC: 'address', ORG: 'organization' };

// Group words into lines, sorted by line_num and word_num.
export function buildLineMap(words) {
  const map = {};
  words.forEach((w) => {
    if (w.line_num == null) return;
    const key = String(w.line_num);
    if (!map[key]) map[key] = { l: w.line_num, words: [] };
    map[key].words.push(w);
  });
  const lines = Object.values(map);
  lines.sort((a, b) => a.l - b.l);
  lines.forEach((line) => line.words.sort((a, b) => a.word_num - b.word_num));
  return lines;
}

// Return the effective NER label for a word.
//   corrected_label === null/undefined -> fall back to ner_label
//   corrected_label === ''             -> explicitly cleared
//   corrected_label === 'B-PER' etc    -> use that
export function wordLabel(w) {
  if (w.corrected_label !== null && w.corrected_label !== undefined) {
    return w.corrected_label || null;
  }
  return w.ner_label || null;
}

export function nerEntityType(w) {
  const lbl = wordLabel(w);
  return lbl ? lbl.replace(/^[BI]-/, '') : null;
}

// Build a flat list of entity spans from words, respecting BIO boundaries.
export function buildEntities(words) {
  const ents = [];
  const sorted = words.slice().sort((a, b) => {
    if (a.line_num !== b.line_num) return (a.line_num || 0) - (b.line_num || 0);
    return (a.word_num || 0) - (b.word_num || 0);
  });
  let cur = null;
  sorted.forEach((w) => {
    const raw = wordLabel(w);
    if (!raw) {
      cur = null;
      return;
    }
    const type = raw.replace(/^[BI]-/, '');
    const prefix = raw.charAt(0);
    if (prefix === 'B' || !cur || cur.type !== type) {
      cur = { type, words: [w] };
      ents.push(cur);
    } else {
      cur.words.push(w);
    }
  });
  return ents.map((e) => ({
    type: e.type,
    text: e.words.map((w) => w.corrected_text || w.ocr_text).join(' '),
    wordIds: e.words.map((w) => w.id),
    words: e.words,
  }));
}

// Group entities by type and deduplicate by lowercased trimmed text.
export function groupedEntities(words) {
  const ents = buildEntities(words);
  const byType = { PER: {}, LOC: {}, ORG: {} };
  ents.forEach((e) => {
    if (!byType[e.type]) byType[e.type] = {};
    const key = e.text.trim().toLowerCase();
    if (!key) return;
    if (!byType[e.type][key]) {
      byType[e.type][key] = { type: e.type, text: e.text, count: 0, wordIds: [], key };
    }
    byType[e.type][key].count += 1;
    byType[e.type][key].wordIds = byType[e.type][key].wordIds.concat(e.wordIds);
  });
  const result = {};
  Object.keys(byType).forEach((t) => {
    const items = Object.values(byType[t]);
    items.sort((a, b) => b.count - a.count);
    result[t] = items;
  });
  return result;
}

// Word ids highlighted by the active entity key.
export function highlightWordIdSet(words, highlightKey) {
  const ids = new Set();
  if (!highlightKey) return ids;
  const parts = highlightKey.split(':');
  const type = parts[0];
  const key = parts.slice(1).join(':');
  buildEntities(words).forEach((e) => {
    if (e.type === type && e.text.trim().toLowerCase() === key) {
      e.wordIds.forEach((id) => ids.add(id));
    }
  });
  return ids;
}

// Return CSS class for an OCR overlay box.
export function ocrWordClass(w) {
  if (w.is_ditto) return 'ocr-word conf-ditto';
  if (w.corrected_text) return 'ocr-word corrected';
  return 'ocr-word ' + (w.conf < 60 ? 'conf-low' : w.conf < 80 ? 'conf-mid' : 'conf-high');
}

// Suggest subcomp entries for any NER-labelled word inside the bbox.
export function nerSuggestSubcomps(words, bbox) {
  if (!bbox) return [];
  const out = [];
  words.forEach((w) => {
    const entityType = nerEntityType(w);
    if (!entityType) return;
    const inRegion =
      w.left >= bbox.left - 4 &&
      w.top >= bbox.top - 4 &&
      w.left + w.width <= bbox.left + bbox.width + 4 &&
      w.top + w.height <= bbox.top + bbox.height + 4;
    if (!inRegion) return;
    const suggLabel = NER_ENTITY_LABEL[entityType] || entityType.toLowerCase();
    out.push({
      word_id: w.id,
      label: suggLabel,
      text: w.corrected_text || w.ocr_text || '',
    });
  });
  return out;
}
