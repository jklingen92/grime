// One function per Django viewer endpoint. Each returns the parsed JSON
// response. No business logic — callers apply the result to the reducer.

import { postEmpty, postForm, postJson } from './client.js';

// changes: [{ wordId, text }]; '' or null clears the correction.
export function bulkCorrectWords(config, changes) {
  return postJson(
    config.bulkCorrectUrl,
    { changes: changes.map(({ wordId, text }) => ({ word_pk: wordId, text: text ?? '' })) },
    config.csrfToken,
  );
}

export function addWord(config, bbox, correctedText) {
  const body =
    'left=' + bbox.left + '&top=' + bbox.top +
    '&width=' + bbox.width + '&height=' + bbox.height +
    '&corrected_text=' + encodeURIComponent(correctedText ?? '');
  return postForm(config.addWordUrl, body, config.csrfToken);
}

export function deleteWord(config, wordPk) {
  return postForm(config.deleteUrl, 'word_pk=' + encodeURIComponent(wordPk), config.csrfToken);
}

export function bulkDeleteWords(config, wordPks) {
  return postForm(
    config.bulkDeleteUrl,
    'word_pks=' + encodeURIComponent(wordPks.join(',')),
    config.csrfToken,
  );
}

export function markWordDitto(config, wordPk) {
  return postForm(
    config.markAsDittoUrl,
    'word_pk=' + encodeURIComponent(wordPk),
    config.csrfToken,
  );
}

export function bulkMarkDitto(config, wordPks) {
  return postForm(
    config.bulkDittoUrl,
    'word_pks=' + encodeURIComponent(wordPks.join(',')),
    config.csrfToken,
  );
}

// label mirrors Word.corrected_label: null drops the correction (fall back to
// the model's ner_label), '' explicitly clears it, and 'B-PER' etc. set it.
// Undo needs all three to round-trip; JSON keeps null and '' distinct.
export function bulkCorrectNerLabels(config, labels) {
  return postJson(
    config.nerBulkCorrectUrl,
    { changes: labels.map(({ wordId, label }) => ({ word_id: wordId, label })) },
    config.csrfToken,
  );
}

export function createAnnotation(config, fields) {
  const body =
    'source_type_id=' + config.annotationSourceTypeId +
    '&source_id=' + config.annotationSourceId +
    '&label=' + encodeURIComponent(fields.label) +
    '&bbox_left=' + fields.bbox_left +
    '&bbox_top=' + fields.bbox_top +
    '&bbox_width=' + fields.bbox_width +
    '&bbox_height=' + fields.bbox_height +
    '&subcomponents=' + encodeURIComponent(JSON.stringify(fields.subcomponents || []));
  return postForm(config.annotationCreateUrl, body, config.csrfToken);
}

export function updateAnnotation(config, annotationId, fields) {
  const body =
    'annotation_id=' + annotationId +
    '&label=' + encodeURIComponent(fields.label) +
    '&bbox_left=' + fields.bbox_left +
    '&bbox_top=' + fields.bbox_top +
    '&bbox_width=' + fields.bbox_width +
    '&bbox_height=' + fields.bbox_height +
    '&subcomponents=' + encodeURIComponent(JSON.stringify(fields.subcomponents || []));
  return postForm(config.annotationUpdateUrl, body, config.csrfToken);
}

export function deleteAnnotation(config, annotationId) {
  return postForm(
    config.annotationDeleteUrl,
    'annotation_id=' + annotationId,
    config.csrfToken,
  );
}

export function saveImage(config, params) {
  return postJson(config.imageSaveUrl, params, config.csrfToken);
}

export function resetImage(config) {
  return postEmpty(config.imageResetUrl, config.csrfToken);
}

export function autoContrastImage(config) {
  return postEmpty(config.imageAutocontrastUrl, config.csrfToken);
}

export function fetchJobsStatus(config) {
  return fetch(config.jobStatusUrl).then((r) => r.json());
}

export function fetchJobFormFields(config, jobType) {
  return fetch(config.jobFormFieldsUrl + '?type=' + encodeURIComponent(jobType)).then((r) => r.text());
}

export function createJob(config, params) {
  return fetch(config.jobCreateUrl, {
    method: 'POST',
    headers: {
      'X-CSRFToken': config.csrfToken,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  }).then(async (r) => {
    const json = await r.json();
    return { ok: r.ok, ...json };
  });
}

export function pollJob(config, jobPk) {
  return fetch(config.jobPollUrlTpl.replace('{pk}', jobPk)).then((r) => r.json());
}
