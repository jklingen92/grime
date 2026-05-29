/**
 * document-list.js
 * Handles the Add Job modal, tag chip widget, and Edit/Delete document modals.
 * Workers panel polling is handled by the React island in workers-panel.jsx.
 *
 * Expects window.DOC_LIST_CONFIG to be set by the template with:
 *   csrfToken, createUrl, formFieldsUrl, renameUrlTpl, deleteUrlTpl
 */

const { csrfToken: CSRF, createUrl: CREATE_URL,
        formFieldsUrl: FORM_FIELDS_URL,
        renameUrlTpl: RENAME_URL_TPL, deleteUrlTpl: DELETE_URL_TPL } = window.DOC_LIST_CONFIG;

// ---------------------------------------------------------------------------
// Add Job modal — dynamic params fragment
// ---------------------------------------------------------------------------
async function loadJobFormFields(jobType) {
  const container = document.getElementById("job-form-fields");
  if (!jobType) { container.innerHTML = ""; return; }
  try {
    const res = await fetch(`${FORM_FIELDS_URL}?type=${encodeURIComponent(jobType)}`);
    container.innerHTML = res.ok ? await res.text() : "";
  } catch { container.innerHTML = ""; }
}

document.getElementById("id_job_type")?.addEventListener("change", e => {
  loadJobFormFields(e.target.value);
});

// Load fields for the default selection on modal open
document.getElementById("addJobModal").addEventListener("show.bs.modal", () => {
  const sel = document.getElementById("id_job_type");
  if (sel) loadJobFormFields(sel.value);
});

document.getElementById("submit-job-btn").addEventListener("click", async () => {
  const errBox = document.getElementById("job-create-error");
  errBox.classList.add("d-none");
  const form = document.getElementById("add-job-form");
  const data = new FormData(form);
  try {
    const res = await fetch(CREATE_URL, {
      method: "POST",
      headers: { "X-CSRFToken": CSRF },
      body: new URLSearchParams(data),
    });
    const json = await res.json();
    if (res.ok) {
      bootstrap.Modal.getInstance(document.getElementById("addJobModal")).hide();
    } else {
      errBox.textContent = json.error || "Failed to start job";
      errBox.classList.remove("d-none");
    }
  } catch {
    errBox.textContent = "Could not reach server";
    errBox.classList.remove("d-none");
  }
});

// ---------------------------------------------------------------------------
// Tag chip widget factory
// Returns { getTags, setTags } for the given DOM element IDs.
// onchange(tags) is called after every mutation.
// ---------------------------------------------------------------------------
function makeTagWidget(wrapId, chipsId, textId, onchange) {
  const wrap = document.getElementById(wrapId);
  const chipsEl = document.getElementById(chipsId);
  const textInput = document.getElementById(textId);
  if (!wrap || !chipsEl || !textInput) return { getTags: () => [], setTags: () => {} };

  let tags = [];

  function renderChips() {
    chipsEl.innerHTML = "";
    tags.forEach((tag, i) => {
      const chip = document.createElement("span");
      chip.className = "badge d-inline-flex align-items-center gap-1";
      chip.style.backgroundColor = "var(--grime-primary)";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-sm p-0 border-0 bg-transparent text-white lh-1";
      remove.setAttribute("aria-label", `Remove ${tag}`);
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-xmark";
      remove.appendChild(icon);
      remove.addEventListener("click", () => {
        tags.splice(i, 1);
        renderChips();
        onchange(tags);
      });
      chip.appendChild(remove);
      chip.appendChild(document.createTextNode(tag));
      chipsEl.appendChild(chip);
    });
  }

  function addTag(raw) {
    const value = raw.trim();
    if (value && !tags.includes(value)) {
      tags.push(value);
      renderChips();
      onchange(tags);
    }
    textInput.value = "";
  }

  textInput.addEventListener("keydown", e => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      addTag(textInput.value);
    } else if (e.key === "Backspace" && textInput.value === "" && tags.length) {
      tags.pop();
      renderChips();
      onchange(tags);
    }
  });

  textInput.addEventListener("blur", () => {
    if (textInput.value.trim()) addTag(textInput.value);
  });

  wrap.addEventListener("click", () => textInput.focus());

  return {
    getTags: () => tags.slice(),
    setTags: newTags => { tags = newTags.slice(); renderChips(); onchange(tags); },
  };
}

// ---------------------------------------------------------------------------
// Upload form tag widget
// ---------------------------------------------------------------------------
(function () {
  const hidden = document.getElementById("id_tags");
  if (!hidden) return;
  makeTagWidget("tags-input-wrap", "tags-chips", "tags-text-input",
    tags => { hidden.value = JSON.stringify(tags); });
})();

// ---------------------------------------------------------------------------
// Edit Document modal
// ---------------------------------------------------------------------------
let editDocPk = null;
const editTagWidget = makeTagWidget("edit-tags-wrap", "edit-tags-chips", "edit-tags-text", () => {});

document.getElementById("editDocModal").addEventListener("show.bs.modal", e => {
  const btn = e.relatedTarget;
  editDocPk = btn.dataset.docPk;
  document.getElementById("edit-doc-title").value = btn.dataset.docTitle;
  document.getElementById("edit-doc-error").classList.add("d-none");
  try {
    editTagWidget.setTags(JSON.parse(btn.dataset.docTags || "[]"));
  } catch { editTagWidget.setTags([]); }
});

document.getElementById("edit-doc-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errBox = document.getElementById("edit-doc-error");
  errBox.classList.add("d-none");
  const title = document.getElementById("edit-doc-title").value.trim();
  const tags = editTagWidget.getTags();
  try {
    const res = await fetch(RENAME_URL_TPL.replace("{pk}", editDocPk), {
      method: "POST",
      headers: { "X-CSRFToken": CSRF, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, tags: JSON.stringify(tags) }),
    });
    const json = await res.json();
    if (res.ok) {
      const row = document.querySelector(`[data-doc-row="${editDocPk}"]`);
      if (row) {
        row.querySelector(".doc-title-cell").textContent = json.title;
        row.querySelectorAll("[data-doc-pk]").forEach(el => {
          el.dataset.docTitle = json.title;
          el.dataset.docTags = JSON.stringify(json.tags);
        });
        const tagsCell = row.querySelector(".doc-tags-cell");
        if (tagsCell) tagsCell.innerHTML = renderTagBadges(json.tags);
      }
      bootstrap.Modal.getInstance(document.getElementById("editDocModal")).hide();
    } else {
      errBox.textContent = json.error || "Failed to save.";
      errBox.classList.remove("d-none");
    }
  } catch {
    errBox.textContent = "Could not reach server.";
    errBox.classList.remove("d-none");
  }
});

function renderTagBadges(tags) {
  if (!tags || !tags.length) return '<span class="text-muted">—</span>';
  return '<div class="d-flex flex-wrap gap-1">' +
    tags.map(t => `<span class="badge" style="background-color:var(--grime-primary)">${t}</span>`).join("") +
    '</div>';
}

// ---------------------------------------------------------------------------
// Delete Document modal
// ---------------------------------------------------------------------------
let deleteDocPk = null;

document.getElementById("deleteDocModal").addEventListener("show.bs.modal", e => {
  const btn = e.relatedTarget;
  deleteDocPk = btn.dataset.docPk;
  document.getElementById("delete-doc-name").textContent = btn.dataset.docTitle;
  document.getElementById("delete-doc-error").classList.add("d-none");
});

document.getElementById("delete-doc-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errBox = document.getElementById("delete-doc-error");
  errBox.classList.add("d-none");
  try {
    const res = await fetch(DELETE_URL_TPL.replace("{pk}", deleteDocPk), {
      method: "POST",
      headers: { "X-CSRFToken": CSRF },
    });
    if (res.ok) {
      document.querySelector(`[data-doc-row="${deleteDocPk}"]`)?.remove();
      bootstrap.Modal.getInstance(document.getElementById("deleteDocModal")).hide();
    } else {
      const json = await res.json().catch(() => ({}));
      errBox.textContent = json.error || "Failed to delete.";
      errBox.classList.remove("d-none");
    }
  } catch {
    errBox.textContent = "Could not reach server.";
    errBox.classList.remove("d-none");
  }
});
