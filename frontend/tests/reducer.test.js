import { describe, expect, it } from 'vitest';
import { reducer } from '../src/viewer/state/reducer.js';
import { buildInitialState, IMAGE_DEFAULTS } from '../src/viewer/state/initialState.js';
import { SAMPLE_WORDS, word } from './helpers.js';

const init = (config = {}) => buildInitialState({ ocrWords: SAMPLE_WORDS, ...config });

describe('buildInitialState', () => {
  it('indexes words and defaults the image to identity', () => {
    const s = init();
    expect(s.wordById[4].ocr_text).toBe('Paris');
    expect(s.image.current).toEqual(IMAGE_DEFAULTS);
  });

  it('converts saved image params to slider space', () => {
    const s = init({ imageAdjustments: { brightness: 0.1, contrast: 1.5, rotate90: 5, rotate_fine: '1.2', threshold: '90' } });
    expect(s.image.saved).toMatchObject({ brightness: 10, contrast: 150, rotate90: 1, rotateFine: 1.2, threshold: 90 });
  });

  it('picks the default NER model', () => {
    expect(init({ nerModels: [{ key: 'a' }, { key: 'b', default: true }] }).nerModel).toBe('b');
  });
});

describe('word mutations', () => {
  it('WORD_PATCH updates both words and wordById; unknown id is a no-op', () => {
    const s = init();
    const next = reducer(s, { type: 'WORD_PATCH', id: 3, patch: { corrected_text: 'visit' } });
    expect(next.wordById[3].corrected_text).toBe('visit');
    expect(next.words.find((w) => w.id === 3).corrected_text).toBe('visit');
    expect(reducer(s, { type: 'WORD_PATCH', id: 999, patch: {} })).toBe(s);
  });

  it('WORD_ADD / WORD_DELETE keep selection consistent', () => {
    let s = reducer(init(), { type: 'WORD_ADD', word: word(10, 'new', 2, 0) });
    expect(s.words).toHaveLength(7);
    s = reducer(s, { type: 'OCR_SELECT_REPLACE', ids: [10, 1] });
    s = reducer(s, { type: 'WORD_DELETE', id: 10 });
    expect(s.wordById[10]).toBeUndefined();
    expect([...s.ocrSelectedIds]).toEqual([1]);
  });

  it('WORDS_DELETE_BULK removes words and selection', () => {
    let s = reducer(init(), { type: 'OCR_SELECT_REPLACE', ids: [1, 2, 3] });
    s = reducer(s, { type: 'WORDS_DELETE_BULK', ids: [1, 2] });
    expect(s.words.map((w) => w.id)).toEqual([3, 4, 5, 6]);
    expect([...s.ocrSelectedIds]).toEqual([3]);
  });

  it('WORDS_PATCH applies several updates', () => {
    const s = reducer(init(), { type: 'WORDS_PATCH', updates: [{ id: 1, conf: 10 }, { id: 2, conf: 20 }, { id: 404, conf: 0 }] });
    expect([s.wordById[1].conf, s.wordById[2].conf]).toEqual([10, 20]);
    expect(s.wordById[404]).toBeUndefined();
  });
});

describe('selection', () => {
  it('OCR toggle adds then removes', () => {
    let s = reducer(init(), { type: 'OCR_SELECT_TOGGLE', id: 1 });
    expect(s.ocrSelectedIds.has(1)).toBe(true);
    s = reducer(s, { type: 'OCR_SELECT_TOGGLE', id: 1 });
    expect(s.ocrSelectedIds.size).toBe(0);
  });

  it('NER toggle-many clears when all are selected, otherwise adds all', () => {
    let s = reducer(init(), { type: 'NER_SELECT_ADD', ids: [1] });
    s = reducer(s, { type: 'NER_SELECT_TOGGLE_MANY', ids: [1, 2] });
    expect([...s.nerSelectedIds].sort()).toEqual([1, 2]);
    s = reducer(s, { type: 'NER_SELECT_TOGGLE_MANY', ids: [1, 2] });
    expect(s.nerSelectedIds.size).toBe(0);
  });
});

describe('annotations', () => {
  it('add / delete track the document count and never go negative', () => {
    let s = reducer(init(), { type: 'ANNOTATION_ADD', annotation: { id: 1 } });
    expect(s.docAnnotationCount).toBe(1);
    s = reducer(s, { type: 'ANNOTATION_DELETE', id: 1 });
    s = reducer(s, { type: 'ANNOTATION_DELETE', id: 1 });
    expect(s.docAnnotationCount).toBe(0);
    expect(s.annotations).toEqual([]);
  });

  it('exiting the editor drops only transient undo entries', () => {
    let s = init();
    s = reducer(s, { type: 'PUSH_UNDO', entry: { type: 'annotation-bbox-change' } });
    s = reducer(s, { type: 'PUSH_UNDO', entry: { type: 'word-patch' } });
    s = reducer(s, { type: 'ANNOTATION_EDITOR_EXIT' });
    expect(s.undoStack).toEqual([{ type: 'word-patch' }]);
    expect(s.annotation.phase).toBe('draw');
  });
});

describe('image', () => {
  it('patch / reset / mark saved', () => {
    let s = reducer(init(), { type: 'IMAGE_PATCH_CURRENT', patch: { brightness: 20 } });
    expect(s.image.current.brightness).toBe(20);
    expect(s.image.saved.brightness).toBe(0);
    s = reducer(s, { type: 'IMAGE_MARK_SAVED', params: s.image.current, hasCorrected: true });
    expect(s.image.saved.brightness).toBe(20);
    expect(s.image.hasCorrected).toBe(true);
    s = reducer(s, { type: 'IMAGE_RESET_LOCAL' });
    expect(s.image.current).toEqual(IMAGE_DEFAULTS);
  });
});

describe('undo / redo stacks', () => {
  it('PUSH_UNDO clears redo; pops are safe when empty', () => {
    let s = init();
    s = reducer(s, { type: 'PUSH_REDO', entry: { n: 1 } });
    s = reducer(s, { type: 'PUSH_UNDO', entry: { n: 2 } });
    expect(s.redoStack).toEqual([]);
    s = reducer(s, { type: 'POP_UNDO' });
    expect(reducer(s, { type: 'POP_UNDO' })).toBe(s);
    expect(reducer(s, { type: 'POP_REDO' })).toBe(s);
  });

  it('unknown actions return the same state', () => {
    const s = init();
    expect(reducer(s, { type: 'NOPE' })).toBe(s);
  });
});
