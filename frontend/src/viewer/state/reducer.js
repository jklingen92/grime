// Central reducer for the viewer. Every mutation flows through here. Actions
// that change persistent state push an inverse onto the undo stack via
// PUSH_UNDO; UNDO/REDO replay that inverse and re-record.

import { IMAGE_DEFAULTS } from './initialState.js';

export function reducer(state, action) {
  switch (action.type) {
    case 'SET_TAB':
      return { ...state, tab: action.tab };

    case 'SET_ZOOM':
      return { ...state, zoomLevel: action.zoomLevel };

    case 'SET_SIDE_PANEL_WIDTH':
      return { ...state, sidePanelWidth: action.width };

    case 'TOGGLE_BOXES':
      return { ...state, boxesHidden: !state.boxesHidden };

    case 'SET_DRAW_MODE':
      return { ...state, drawMode: action.active };

    /* ─── OCR selection ─── */

    case 'OCR_SELECT_REPLACE': {
      const set = new Set(action.ids);
      return { ...state, ocrSelectedIds: set };
    }

    case 'OCR_SELECT_TOGGLE': {
      const next = new Set(state.ocrSelectedIds);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { ...state, ocrSelectedIds: next };
    }

    case 'OCR_SELECT_ADD': {
      const next = new Set(state.ocrSelectedIds);
      action.ids.forEach((id) => next.add(id));
      return { ...state, ocrSelectedIds: next };
    }

    case 'OCR_SELECT_CLEAR':
      return { ...state, ocrSelectedIds: new Set() };

    case 'OCR_SET_SEARCH':
      return { ...state, textSearchQuery: action.query };

    /* ─── Word mutations ─── */

    case 'WORD_PATCH': {
      const w = state.wordById[action.id];
      if (!w) return state;
      const patched = { ...w, ...action.patch };
      const wordById = { ...state.wordById, [action.id]: patched };
      const words = state.words.map((x) => (x.id === action.id ? patched : x));
      return { ...state, wordById, words };
    }

    case 'WORDS_PATCH': {
      const wordById = { ...state.wordById };
      action.updates.forEach((u) => {
        if (wordById[u.id]) wordById[u.id] = { ...wordById[u.id], ...u };
      });
      const words = state.words.map((w) => wordById[w.id] || w);
      return { ...state, wordById, words };
    }

    case 'WORD_ADD': {
      const w = action.word;
      const wordById = { ...state.wordById, [w.id]: w };
      const words = [...state.words, w];
      return { ...state, wordById, words };
    }

    case 'WORD_DELETE': {
      const wordById = { ...state.wordById };
      delete wordById[action.id];
      const words = state.words.filter((w) => w.id !== action.id);
      const sel = new Set(state.ocrSelectedIds);
      sel.delete(action.id);
      return { ...state, wordById, words, ocrSelectedIds: sel };
    }

    case 'WORDS_DELETE_BULK': {
      const ids = new Set(action.ids);
      const wordById = { ...state.wordById };
      action.ids.forEach((id) => delete wordById[id]);
      const words = state.words.filter((w) => !ids.has(w.id));
      const sel = new Set();
      state.ocrSelectedIds.forEach((id) => {
        if (!ids.has(id)) sel.add(id);
      });
      return { ...state, wordById, words, ocrSelectedIds: sel };
    }

    /* ─── NER ─── */

    case 'NER_SELECT_REPLACE':
      return { ...state, nerSelectedIds: new Set(action.ids) };

    case 'NER_SELECT_ADD': {
      const next = new Set(state.nerSelectedIds);
      action.ids.forEach((id) => next.add(id));
      return { ...state, nerSelectedIds: next };
    }

    case 'NER_SELECT_TOGGLE_MANY': {
      const next = new Set(state.nerSelectedIds);
      const allHave = action.ids.every((id) => next.has(id));
      action.ids.forEach((id) => {
        if (allHave) next.delete(id);
        else next.add(id);
      });
      return { ...state, nerSelectedIds: next };
    }

    case 'NER_SELECT_CLEAR':
      return { ...state, nerSelectedIds: new Set() };

    case 'NER_SET_HIGHLIGHT':
      return { ...state, nerHighlightKey: action.key };

    case 'NER_SET_MODEL':
      return { ...state, nerModel: action.model };

    /* ─── Annotations ─── */

    case 'ANNOTATION_ADD': {
      return {
        ...state,
        annotations: [...state.annotations, action.annotation],
        docAnnotationCount: state.docAnnotationCount + 1,
      };
    }

    case 'ANNOTATION_REPLACE': {
      const annotations = state.annotations.map((a) =>
        a.id === action.annotation.id ? action.annotation : a,
      );
      return { ...state, annotations };
    }

    case 'ANNOTATION_DELETE': {
      const annotations = state.annotations.filter((a) => a.id !== action.id);
      return {
        ...state,
        annotations,
        docAnnotationCount: Math.max(0, state.docAnnotationCount - 1),
      };
    }

    case 'ANNOTATION_PATCH_EDITOR':
      return { ...state, annotation: { ...state.annotation, ...action.patch } };

    case 'ANNOTATION_EDITOR_ENTER_LABELING':
      return {
        ...state,
        annotation: {
          ...state.annotation,
          phase: 'labeling',
          pendingBbox: action.bbox,
          editingId: action.editingId ?? null,
          pendingLabel: action.label ?? '',
          pendingSubcomps: action.subcomponents ? action.subcomponents.slice() : [],
          subSelectedIds: new Set(),
          resizing: null,
        },
      };

    case 'ANNOTATION_EDITOR_EXIT': {
      const isTransient = (e) =>
        e.type === 'annotation-subcomp-change' || e.type === 'annotation-bbox-change';
      return {
        ...state,
        annotation: {
          phase: 'draw',
          pendingBbox: null,
          editingId: null,
          pendingLabel: '',
          pendingSubcomps: [],
          subSelectedIds: new Set(),
          resizing: null,
        },
        undoStack: state.undoStack.filter((e) => !isTransient(e)),
        redoStack: state.redoStack.filter((e) => !isTransient(e)),
      };
    }

    case 'ANNOTATION_SET_SUBCOMPS':
      return {
        ...state,
        annotation: { ...state.annotation, pendingSubcomps: action.subcomps.slice() },
      };

    case 'ANNOTATION_SET_PENDING_BBOX':
      return {
        ...state,
        annotation: { ...state.annotation, pendingBbox: action.bbox ? { ...action.bbox } : null },
      };

    case 'ANNOTATION_SET_SUB_SELECTED':
      return {
        ...state,
        annotation: { ...state.annotation, subSelectedIds: new Set(action.ids) },
      };

    case 'ANNOTATION_TOGGLE_SUB_SELECTED': {
      const next = new Set(state.annotation.subSelectedIds);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { ...state, annotation: { ...state.annotation, subSelectedIds: next } };
    }

    case 'ANNOTATION_SET_RESIZING':
      return { ...state, annotation: { ...state.annotation, resizing: action.resizing } };

    /* ─── Image ─── */

    case 'IMAGE_SET_CURRENT':
      return { ...state, image: { ...state.image, current: { ...action.params } } };

    case 'IMAGE_PATCH_CURRENT':
      return {
        ...state,
        image: { ...state.image, current: { ...state.image.current, ...action.patch } },
      };

    case 'IMAGE_MARK_SAVED':
      return {
        ...state,
        image: {
          ...state.image,
          saved: { ...action.params },
          hasCorrected: action.hasCorrected,
        },
      };

    case 'IMAGE_RESET_LOCAL':
      return { ...state, image: { ...state.image, current: { ...IMAGE_DEFAULTS } } };

    /* ─── Undo / redo ─── */

    case 'PUSH_UNDO':
      return {
        ...state,
        undoStack: [...state.undoStack, action.entry],
        redoStack: [],
      };

    case 'PUSH_REDO_TO_UNDO':
      return { ...state, undoStack: [...state.undoStack, action.entry] };

    case 'POP_UNDO': {
      if (!state.undoStack.length) return state;
      return { ...state, undoStack: state.undoStack.slice(0, -1) };
    }

    case 'POP_REDO': {
      if (!state.redoStack.length) return state;
      return { ...state, redoStack: state.redoStack.slice(0, -1) };
    }

    case 'PUSH_REDO':
      return { ...state, redoStack: [...state.redoStack, action.entry] };

    default:
      return state;
  }
}
