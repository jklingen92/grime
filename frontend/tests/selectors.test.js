import { describe, expect, it } from 'vitest';
import {
  buildEntities,
  buildLineMap,
  groupedEntities,
  highlightWordIdSet,
  nerSuggestSubcomps,
  ocrWordClass,
  wordLabel,
} from '../src/viewer/state/selectors.js';
import { SAMPLE_WORDS, word } from './helpers.js';

describe('buildLineMap', () => {
  it('groups by line and sorts words', () => {
    const lines = buildLineMap([word(2, 'b', 1, 1), word(1, 'a', 1, 0), word(3, 'c', 0, 0), word(9, 'x', null, 0)]);
    expect(lines.map((l) => l.l)).toEqual([0, 1]);
    expect(lines[1].words.map((w) => w.id)).toEqual([1, 2]);
  });
});

describe('wordLabel', () => {
  it('prefers corrected_label, treats empty string as cleared', () => {
    expect(wordLabel({ ner_label: 'B-PER' })).toBe('B-PER');
    expect(wordLabel({ ner_label: 'B-PER', corrected_label: 'B-ORG' })).toBe('B-ORG');
    expect(wordLabel({ ner_label: 'B-PER', corrected_label: '' })).toBeNull();
    expect(wordLabel({ ner_label: 'B-PER', corrected_label: null })).toBe('B-PER');
  });
});

describe('buildEntities', () => {
  it('joins BIO spans and splits on a new B-', () => {
    const ents = buildEntities(SAMPLE_WORDS);
    expect(ents.map((e) => [e.type, e.text])).toEqual([
      ['PER', 'John Smith'],
      ['LOC', 'Paris'],
      ['PER', 'John Smith'],
    ]);
  });

  it('uses corrected text and honours cleared labels', () => {
    const words = [
      word(1, 'Jon', 0, 0, { ner_label: 'B-PER', corrected_text: 'John' }),
      word(2, 'Smith', 0, 1, { ner_label: 'I-PER', corrected_label: '' }),
    ];
    const ents = buildEntities(words);
    expect(ents).toHaveLength(1);
    expect(ents[0].text).toBe('John');
  });
});

describe('groupedEntities', () => {
  it('dedupes case-insensitively and counts', () => {
    const g = groupedEntities(SAMPLE_WORDS);
    expect(g.PER).toHaveLength(1);
    expect(g.PER[0].count).toBe(2);
    expect(g.PER[0].wordIds).toEqual([1, 2, 5, 6]);
    expect(g.LOC[0].text).toBe('Paris');
    expect(g.ORG).toEqual([]);
  });
});

describe('highlightWordIdSet', () => {
  it('returns ids for the matching entity key only', () => {
    expect([...highlightWordIdSet(SAMPLE_WORDS, 'PER:john smith')].sort()).toEqual([1, 2, 5, 6]);
    expect(highlightWordIdSet(SAMPLE_WORDS, null).size).toBe(0);
  });
});

describe('ocrWordClass', () => {
  it('maps confidence and correction state', () => {
    expect(ocrWordClass({ conf: 50 })).toBe('ocr-word conf-low');
    expect(ocrWordClass({ conf: 70 })).toBe('ocr-word conf-mid');
    expect(ocrWordClass({ conf: 95 })).toBe('ocr-word conf-high');
    expect(ocrWordClass({ conf: 95, corrected_text: 'x' })).toBe('ocr-word corrected');
    expect(ocrWordClass({ conf: 95, corrected_text: 'x', is_ditto: true })).toBe('ocr-word conf-ditto');
  });
});

describe('nerSuggestSubcomps', () => {
  it('suggests labels for NER words inside the bbox', () => {
    const out = nerSuggestSubcomps(SAMPLE_WORDS, { left: 0, top: 0, width: 200, height: 20 });
    expect(out.map((s) => [s.word_id, s.label, s.text])).toEqual([
      [1, 'name', 'John'],
      [2, 'name', 'Smith'],
    ]);
    expect(nerSuggestSubcomps(SAMPLE_WORDS, null)).toEqual([]);
  });
});
