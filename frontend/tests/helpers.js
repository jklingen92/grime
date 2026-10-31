// Shared fixtures for viewer tests. No network: API modules are mocked per-test.

export function word(id, text, line, num, extra = {}) {
  return {
    id,
    ocr_text: text,
    line_num: line,
    word_num: num,
    left: num * 50,
    top: line * 20,
    width: 40,
    height: 15,
    conf: 90,
    ...extra,
  };
}

export const SAMPLE_WORDS = [
  word(1, 'John', 0, 0, { ner_label: 'B-PER' }),
  word(2, 'Smith', 0, 1, { ner_label: 'I-PER' }),
  word(3, 'visited', 0, 2),
  word(4, 'Paris', 1, 0, { ner_label: 'B-LOC' }),
  word(5, 'John', 1, 1, { ner_label: 'B-PER' }),
  word(6, 'Smith', 1, 2, { ner_label: 'I-PER' }),
];
