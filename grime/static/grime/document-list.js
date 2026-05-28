/**
 * document-list.js
 * Handles the workers panel, Add Job modal, and job status polling
 * on the document list page.
 *
 * Expects window.DOC_LIST_CONFIG to be set by the template with:
 *   csrfToken, statusUrl, createUrl, formFieldsUrl, cancelUrlTpl
 */

const { csrfToken: CSRF, statusUrl: STATUS_URL, createUrl: CREATE_URL,
        formFieldsUrl: FORM_FIELDS_URL, cancelUrlTpl: CANCEL_URL_TPL,
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
// Cancel job
// ---------------------------------------------------------------------------
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-cancel-job]");
  if (!btn) return;
  fetch(CANCEL_URL_TPL.replace("{pk}", btn.dataset.cancelJob), {
    method: "POST", headers: { "X-CSRFToken": CSRF },
  });
  btn.closest("[data-job-card]")?.remove();
});

// ---------------------------------------------------------------------------
// Poll jobs_status every 3 s
// ---------------------------------------------------------------------------
async function pollJobs() {
  try {
    const res = await fetch(STATUS_URL);
    if (!res.ok) return;
    const data = await res.json();
    updateWorkersPanel(data.slots || []);
    updatePendingBadge(data.pending_count || 0);
  } catch {}
}

function updatePendingBadge(count) {
  const el = document.getElementById("pending-count-badge");
  if (el) el.textContent = `${count} pending`;
}

function updateWorkersPanel(slots) {
  for (const slot of slots) {
    const content = document.querySelector(`.slot-content[data-slot="${slot.slot_number}"]`);
    if (!content) continue;

    if (!slot.job) {
      content.innerHTML = `<span class="text-muted">Idle</span>`;
      continue;
    }
    const j = slot.job;
    const pct = j.pages_total ? Math.round(j.pages_done / j.pages_total * 100) : 0;
    const badgeCls = j.status === "running" ? "bg-primary" : "bg-warning text-dark";
    const progressHtml = j.pages_total ? `
      <div class="progress mt-1" style="height:4px">
        <div class="progress-bar" role="progressbar" style="width:${pct}%"
             aria-valuenow="${j.pages_done}" aria-valuemin="0" aria-valuemax="${j.pages_total}"></div>
      </div>
      <div class="text-muted" style="font-size:10px">${j.pages_done}/${j.pages_total} pages</div>` : "";
    content.innerHTML = `
      <div class="d-flex align-items-center gap-2" data-job-card>
        <div class="spinner-border spinner-border-sm text-primary" role="status" style="width:.7rem;height:.7rem;border-width:2px">
          <span class="visually-hidden">Running</span>
        </div>
        <span class="badge ${badgeCls}">${j.job_type_label} ${j.status}</span>
        <span class="text-truncate small flex-grow-1" title="${j.document}">${j.document}</span>
        <button class="btn-close ms-auto" style="font-size:.55rem"
                data-cancel-job="${j.pk}" aria-label="Cancel"></button>
      </div>${progressHtml}`;
  }
}

setInterval(pollJobs, 3000);
pollJobs();

// ---------------------------------------------------------------------------
// Edit Document modal
// ---------------------------------------------------------------------------
let editDocPk = null;

document.getElementById("editDocModal").addEventListener("show.bs.modal", e => {
  const btn = e.relatedTarget;
  editDocPk = btn.dataset.docPk;
  document.getElementById("edit-doc-title").value = btn.dataset.docTitle;
  document.getElementById("edit-doc-error").classList.add("d-none");
});

document.getElementById("edit-doc-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errBox = document.getElementById("edit-doc-error");
  errBox.classList.add("d-none");
  const title = document.getElementById("edit-doc-title").value.trim();
  try {
    const res = await fetch(RENAME_URL_TPL.replace("{pk}", editDocPk), {
      method: "POST",
      headers: { "X-CSRFToken": CSRF, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title }),
    });
    const json = await res.json();
    if (res.ok) {
      const row = document.querySelector(`[data-doc-row="${editDocPk}"]`);
      if (row) {
        row.querySelector(".doc-title-cell").textContent = json.title;
        row.querySelectorAll("[data-doc-pk]").forEach(el => el.dataset.docTitle = json.title);
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

// ---------------------------------------------------------------------------
// Label tag-input widget
// ---------------------------------------------------------------------------
(function () {
  const hidden = document.getElementById("id_tags");
  const wrap = document.getElementById("tags-input-wrap");
  const textInput = document.getElementById("tags-text-input");
  const chipsEl = document.getElementById("tags-chips");
  if (!hidden || !wrap || !textInput || !chipsEl) return;

  let tags = [];

  function sync() {
    hidden.value = JSON.stringify(tags);
  }

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
        sync();
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
      sync();
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
      sync();
    }
  });

  textInput.addEventListener("blur", () => {
    if (textInput.value.trim()) addTag(textInput.value);
  });

  wrap.addEventListener("click", () => textInput.focus());
})();
