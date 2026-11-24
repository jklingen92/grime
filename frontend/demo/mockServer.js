// In-browser stand-in for the viewer endpoints in grime/viewer.py. Replaces
// window.fetch: requests to `demo:` URLs are answered from an in-memory page
// store with the same JSON shapes the Django views return; anything else goes
// to the real network.
//
// Deliberately skipped: _run_post_ocr side effects (every `updated` is []),
// PIL image baking, autocontrast, jobs and PDF export.

// VIEWER_CONFIG key -> mock route. Mirrors get_viewer_urls() in grime/viewer.py.
export const DEMO_URLS = {
  correctUrl: 'demo:words/correct',
  addWordUrl: 'demo:words/add',
  deleteUrl: 'demo:words/delete',
  nerCorrectUrl: 'demo:words/ner-correct',
  markAsDittoUrl: 'demo:words/mark-ditto',
  bulkDeleteUrl: 'demo:words/bulk-delete',
  bulkDittoUrl: 'demo:words/bulk-ditto',
  bulkCorrectUrl: 'demo:words/bulk-correct',
  nerBulkCorrectUrl: 'demo:words/bulk-ner-correct',
  annotationCreateUrl: 'demo:annotations/create',
  annotationUpdateUrl: 'demo:annotations/update',
  annotationDeleteUrl: 'demo:annotations/delete',
  imageSaveUrl: 'demo:image/save',
  imageResetUrl: 'demo:image/reset',
  // Never called: the controls using these are demo-disabled. Present so the
  // viewer still renders them (it hides features whose URL is missing).
  imageAutocontrastUrl: 'demo:image/autocontrast',
  exportPdfUrl: 'demo:export/pdf',
};

const VALID_NER_LABELS = new Set([null, '', 'B-PER', 'I-PER', 'B-LOC', 'I-LOC', 'B-ORG', 'I-ORG']);

// Matches _DEFAULT_IMAGE_PARAMS in grime/viewer.py.
const DEFAULT_IMAGE_PARAMS = {
  brightness: 0.0, contrast: 1.0, gamma: 1.0, black: 0, white: 255,
  grayscale: false, invert: false, threshold: null, sharpen: false,
  rotate90: 0, rotate_fine: 0.0,
};

// store: { words, annotations, imageAdjustments, imageHasCorrected, nextId }
// onChange(store) runs after every successful write (used for localStorage).
export function installMockServer(store, { originalImageUrl, onChange }) {
  const realFetch = window.fetch.bind(window);

  const ok = (data) => ({ status: 200, body: { ok: true, ...data } });
  const err = (status, error) => ({ status, body: { error } });
  // New rows get negative ids so they can never collide with exported pks.
  const newId = () => store.nextId--;
  const findWord = (raw) => store.words.find((w) => w.id === parseInt(raw, 10));
  const parsePks = (raw) => (raw || '').split(',').filter((p) => p.trim()).map(Number);

  function parseAnnotation(f) {
    const label = (f.get('label') || '').trim();
    if (!label) return [null, err(400, 'label required')];
    const fields = {
      label,
      bbox_left: parseInt(f.get('bbox_left'), 10),
      bbox_top: parseInt(f.get('bbox_top'), 10),
      bbox_width: parseInt(f.get('bbox_width'), 10),
      bbox_height: parseInt(f.get('bbox_height'), 10),
      subcomponents: JSON.parse(f.get('subcomponents') || '[]'),
    };
    if (Object.values(fields).some((v) => Number.isNaN(v))) return [null, err(400, 'Invalid bbox')];
    return [fields, null];
  }

  function markDitto(w) {
    Object.assign(w, { ocr_text: '"', corrected_text: null, is_ditto: false });
  }

  // f: URLSearchParams of the form body; json: parsed JSON body (image save).
  const routes = {
    'words/correct': (f) => {
      const w = findWord(f.get('word_pk'));
      if (!w) return err(404, 'Word not found on this page');
      w.corrected_text = (f.get('corrected_text') || '').trim() || null;
      return ok({ corrected_text: w.corrected_text, updated: [] });
    },
    'words/add': (f) => {
      const [left, top, width, height] = ['left', 'top', 'width', 'height'].map((k) => parseInt(f.get(k), 10));
      if ([left, top, width, height].some(Number.isNaN)) return err(400, 'Invalid coordinates');
      if (width <= 0 || height <= 0) return err(400, 'Region must have positive size');
      const line0 = store.words.filter((w) => w.line_num === 0).map((w) => w.word_num);
      const word = {
        id: newId(), left, top, width, height, conf: 0, ocr_text: '',
        corrected_text: (f.get('corrected_text') || '').trim() || null,
        is_ditto: false, ner_label: null, corrected_label: null,
        line_num: 0, word_num: line0.length ? Math.max(...line0) + 1 : 0,
      };
      store.words.push(word);
      return ok({ word, updated: [] });
    },
    'words/delete': (f) => {
      const w = findWord(f.get('word_pk'));
      if (!w) return err(404, 'Word not found on this page');
      store.words = store.words.filter((x) => x !== w);
      return ok({ deleted_id: w.id, updated: [] });
    },
    'words/ner-correct': (f) => {
      const w = findWord(f.get('word_id'));
      if (!w) return err(404, 'Word not found on this page');
      const raw = (f.get('label') || '').trim();
      const label = raw === 'NONE' ? '' : raw || null;
      if (!VALID_NER_LABELS.has(label)) return err(400, `Invalid label ${label}`);
      w.corrected_label = label;
      return ok({ word_id: w.id, label });
    },
    'words/mark-ditto': (f) => {
      const w = findWord(f.get('word_pk'));
      if (!w) return err(404, 'Word not found on this page');
      markDitto(w);
      return ok({ word_pk: w.id, updated: [] });
    },
    'words/bulk-delete': (f) => {
      const pks = new Set(parsePks(f.get('word_pks')));
      if (!pks.size) return err(400, 'No word_pks provided');
      const found = store.words.filter((w) => pks.has(w.id)).map((w) => w.id);
      store.words = store.words.filter((w) => !pks.has(w.id));
      return ok({ deleted_ids: found, deleted: found.length, updated: [] });
    },
    'words/bulk-ditto': (f) => {
      const pks = new Set(parsePks(f.get('word_pks')));
      if (!pks.size) return err(400, 'No word_pks provided');
      const marked = store.words.filter((w) => pks.has(w.id));
      if (!marked.length) return err(404, 'No words found on this page');
      marked.forEach(markDitto);
      return ok({ marked_pks: marked.map((w) => w.id), updated: [] });
    },
    'words/bulk-correct': (f, json) => {
      const changes = json?.changes || [];
      const words = changes.map((c) => findWord(c.word_pk));
      if (!words.length) return err(400, 'No changes provided');
      if (words.some((w) => !w)) return err(404, 'Word not found on this page');
      const results = changes.map((c, i) => {
        words[i].corrected_text = String(c.text || '').trim() || null;
        return { word_pk: words[i].id, corrected_text: words[i].corrected_text };
      });
      return ok({ results, updated: [] });
    },
    'words/bulk-ner-correct': (f, json) => {
      const changes = json?.changes || [];
      const words = changes.map((c) => findWord(c.word_id));
      if (!words.length) return err(400, 'No changes provided');
      if (words.some((w) => !w)) return err(404, 'Word not found on this page');
      const bad = changes.find((c) => !VALID_NER_LABELS.has(c.label));
      if (bad) return err(400, `Invalid label ${bad.label}`);
      const results = changes.map((c, i) => {
        words[i].corrected_label = c.label;
        return { word_id: words[i].id, label: c.label };
      });
      return ok({ results });
    },
    'annotations/create': (f) => {
      const [fields, e] = parseAnnotation(f);
      if (e) return e;
      const annotation = { id: newId(), ...fields, created_by_id: null };
      store.annotations.push(annotation);
      return ok({ annotation });
    },
    'annotations/update': (f) => {
      const a = store.annotations.find((x) => x.id === parseInt(f.get('annotation_id'), 10));
      if (!a) return err(404, 'Annotation not found on this page');
      const [fields, e] = parseAnnotation(f);
      if (e) return e;
      Object.assign(a, fields);
      return ok({ annotation: a });
    },
    'annotations/delete': (f) => {
      const id = parseInt(f.get('annotation_id'), 10);
      const before = store.annotations.length;
      store.annotations = store.annotations.filter((x) => x.id !== id);
      if (store.annotations.length === before) return err(404, 'Annotation not found on this page');
      return ok({});
    },
    // No PIL here: remember the params and keep serving the original image.
    'image/save': (f, json) => {
      store.imageAdjustments = { ...DEFAULT_IMAGE_PARAMS, ...(json || {}) };
      store.imageHasCorrected = true;
      return ok({ image_url: originalImageUrl, adjustments: store.imageAdjustments });
    },
    'image/reset': () => {
      store.imageAdjustments = null;
      store.imageHasCorrected = false;
      return ok({ image_url: originalImageUrl });
    },
  };

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('demo:')) return realFetch(input, init);

    const handler = routes[url.slice('demo:'.length)];
    const body = typeof init.body === 'string' ? init.body : '';
    const isJson = (init.headers?.['Content-Type'] || '').includes('json');
    let res;
    try {
      res = handler
        ? handler(new URLSearchParams(isJson ? '' : body), isJson ? JSON.parse(body || '{}') : null)
        : err(404, 'Not available in the demo');
    } catch (e) {
      res = err(400, String(e));
    }
    if (res.status === 200) onChange?.(store);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
