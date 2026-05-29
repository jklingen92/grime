// Shared HTTP helpers for the viewer. All viewer endpoints accept form-encoded
// bodies and return JSON; postForm matches the legacy viewer-core.postJson
// shape so the Django endpoints can stay untouched.

export function postForm(url, body, csrfToken) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrfToken,
    },
    body: typeof body === 'string' ? body : encodeFormBody(body),
  }).then((r) => r.json());
}

export function postJson(url, body, csrfToken) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken,
    },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}

export function postEmpty(url, csrfToken) {
  return fetch(url, {
    method: 'POST',
    headers: { 'X-CSRFToken': csrfToken },
  }).then((r) => r.json());
}

function encodeFormBody(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] ?? ''))
    .join('&');
}
