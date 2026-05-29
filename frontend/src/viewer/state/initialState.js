// Build the initial reducer state from the window.VIEWER_CONFIG payload that
// the Django template emits (see grime/templates/grime/document_detail.html).

const IMAGE_DEFAULTS = {
  brightness: 0,
  contrast: 100,
  gamma: 100,
  black: 0,
  white: 255,
  grayscale: false,
  invert: false,
  threshold: null,
  sharpen: false,
  rotate90: 0,
  rotateFine: 0,
};

function paramsToSliders(saved) {
  if (!saved) return null;
  return {
    brightness: Math.round((saved.brightness || 0) * 100),
    contrast: Math.round((saved.contrast != null ? saved.contrast : 1) * 100),
    gamma: Math.round((saved.gamma != null ? saved.gamma : 1) * 100),
    black: saved.black || 0,
    white: saved.white != null ? saved.white : 255,
    grayscale: !!saved.grayscale,
    invert: !!saved.invert,
    threshold: saved.threshold != null ? parseInt(saved.threshold, 10) : null,
    sharpen: !!saved.sharpen,
    rotate90: saved.rotate90 != null ? ((parseInt(saved.rotate90, 10) % 4) + 4) % 4 : 0,
    rotateFine: saved.rotate_fine != null ? parseFloat(saved.rotate_fine) : 0,
  };
}

function getInitialTab() {
  const t = new URLSearchParams(window.location.search).get('tab');
  const normalized = t === 'tagging' ? 'label' : t;
  return ['ocr', 'ner', 'label', 'image'].includes(normalized) ? normalized : 'ocr';
}

export function buildInitialState(config) {
  const words = config.ocrWords || [];
  const wordById = {};
  words.forEach((w) => {
    if (w.id != null) wordById[w.id] = w;
  });

  const savedImage = paramsToSliders(config.imageAdjustments) || { ...IMAGE_DEFAULTS };

  return {
    tab: getInitialTab(),
    zoomLevel: 1.0,
    sidePanelWidth: 260,

    words,
    wordById,
    ocrSelectedIds: new Set(),
    textSearchQuery: '',

    annotations: (config.annotations || []).slice(),
    annotation: {
      phase: 'draw',
      pendingBbox: null,
      editingId: null,
      pendingLabel: '',
      pendingSubcomps: [],
      subSelectedIds: new Set(),
      resizing: null,
    },

    nerSelectedIds: new Set(),
    nerHighlightKey: null,
    nerModel: (config.nerModels || []).find((m) => m.default)?.key || null,

    image: {
      saved: savedImage,
      current: { ...savedImage },
      hasCorrected: !!config.imageHasCorrected,
    },

    drawMode: false,
    boxesHidden: false,
    undoStack: [],
    redoStack: [],

    docAnnotationCount: config.docAnnotationCount || 0,
  };
}

export { IMAGE_DEFAULTS };
