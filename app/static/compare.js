"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fileA = $("#file-a"), fileB = $("#file-b"), goBtn = $("#go");
let lastDiff = null;
const edits = new Map();                     // "catkey" -> {cat, key, value}
const LANG = localStorage.getItem("lang") || "en";
const nameOf = (e) => (e.loc && (e.loc[LANG] || e.loc.en)) || e.name || e.key;

const QUEST_STATES = ["None", "Available", "Running", "Succeeded", "Failed"];
const CREATE_CATS = new Set(["flags", "inventory"]);   // can create a value that's absent in B
const ORDER = ["quests", "flags", "attributes", "skills", "inventory", "npcs"];

function ready() { goBtn.disabled = !(fileA.files[0] && fileB.files[0]); }
fileA.onchange = ready;
fileB.onchange = ready;

goBtn.onclick = async () => {
  const a = fileA.files[0], b = fileB.files[0];
  if (!a || !b) return;
  edits.clear();
  $("#cmp-error").classList.add("hidden");
  $("#cmp-results").classList.add("hidden");
  $("#cmp-loading").classList.remove("hidden");
  goBtn.disabled = true;
  try {
    const fd = new FormData();
    fd.append("save_a", a);
    fd.append("save_b", b);
    if ($("#inc-npcs").checked) fd.append("include_npcs", "1");
    const r = await fetch("/api/diff", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "compare failed");
    lastDiff = j;
    render();
  } catch (e) {
    $("#cmp-error").textContent = e.message;
    $("#cmp-error").classList.remove("hidden");
  } finally {
    $("#cmp-loading").classList.add("hidden");
    goBtn.disabled = false;
  }
};

$("#cmp-only-changed").onchange = render;

// --- edit tracking ---------------------------------------------------------
function editKey(cat, key) { return cat + "" + key; }
function recordEdit(inp) {
  const { cat, key, orig } = inp.dataset;
  const id = editKey(cat, key);
  const v = inp.value.trim();
  if (v === "" || v === orig) edits.delete(id);
  else edits.set(id, { cat, key, value: v });
  inp.classList.toggle("edited", edits.has(id));
  updateExport();
}
function updateExport() {
  const btn = $("#cmp-export");
  btn.textContent = `Export edited B (${edits.size})`;
  btn.classList.toggle("hidden", edits.size === 0);
}

// --- value cell (editable for editable categories) -------------------------
function editCell(cat, key, aVal, bVal, hasB, hasA) {
  const common = `class="cmp-edit" data-cat="${esc(cat)}" data-key="${esc(key)}" data-orig="${hasB ? esc(bVal) : ""}"`;
  let field;
  if (cat === "quests") {
    field = `<select ${common}>` +
      QUEST_STATES.map(s => `<option ${s === bVal ? "selected" : ""}>${s}</option>`).join("") +
      `</select>`;
  } else {
    field = `<input ${common} type="number" step="any" value="${hasB ? esc(bVal) : ""}"` +
      `${hasB ? "" : ' placeholder="(absent)"'}>`;
  }
  const copy = hasA ? `<button type="button" class="link cmp-copy" data-a="${esc(aVal)}" title="copy A's value">← A</button>` : "";
  return `<span class="arrow">→</span>${field}${copy}`;
}

function rowsHTML(catKey, cat, onlyChanged) {
  const editable = cat.editable;
  let html = "";
  const sub = (title, list, cls, render) => {
    if (!list || !list.length) return;
    html += `<div class="diff-sub">${title} (${list.length})</div>` + list.map(render).join("");
  };
  const changedRow = (e) => {
    const cell = editable
      ? editCell(catKey, e.key, e.a, e.b, true, true)
      : `<span class="arrow">→</span><span class="v">${esc(e.b)}</span>`;
    return `<div class="diff-row chg"><span class="k">${esc(nameOf(e))}</span><span class="v">${esc(e.a)}</span>${cell}</div>`;
  };
  if (!onlyChanged) {
    sub("Added", cat.added, "add", (e) => {
      const cell = editable
        ? editCell(catKey, e.key, undefined, e.b, true, false)   // B present, no A
        : `<span class="v">${esc(e.b)}</span>`;
      return `<div class="diff-row add"><span class="k">${esc(nameOf(e))}</span>${cell}</div>`;
    });
    sub("Removed", cat.removed, "rem", (e) => {
      const canCreate = editable && CREATE_CATS.has(catKey);
      const cell = canCreate
        ? editCell(catKey, e.key, e.a, undefined, false, true)   // B absent, offer copy-A to create
        : `<span class="v">${esc(e.a)}</span>`;
      return `<div class="diff-row rem"><span class="k">${esc(nameOf(e))}</span><span class="v">${esc(e.a)}</span>${cell}</div>`;
    });
  }
  sub("Changed", cat.changed, "chg", changedRow);
  return html;
}

function render() {
  const d = lastDiff;
  if (!d) return;
  $("#cmp-a").textContent = d.a_name;
  $("#cmp-b").textContent = d.b_name;
  $("#cmp-total").textContent = `${d.total} difference${d.total === 1 ? "" : "s"}`;
  const onlyChanged = $("#cmp-only-changed").checked;

  const cats = d.categories;
  const keys = ORDER.filter(k => cats[k]).concat(Object.keys(cats).filter(k => !ORDER.includes(k)));
  let html = "";
  for (const key of keys) {
    const cat = cats[key];
    const c = cat.counts;
    const shown = onlyChanged ? c.changed : (c.added + c.removed + c.changed);
    const badge = `<span class="d-add">+${c.added}</span> <span class="d-rem">-${c.removed}</span> <span class="d-chg">~${c.changed}</span>`;
    const tag = cat.editable ? ` <span class="tag">editable</span>` : "";
    html += `<div class="diff-grp"><h3>${esc(cat.label)} ${badge}${tag}</h3>`;
    if (cat.error) html += `<div class="empty">could not read: ${esc(cat.error)}</div>`;
    else if (!shown) html += `<div class="empty">no ${onlyChanged ? "changes" : "differences"}</div>`;
    else html += rowsHTML(key, cat, onlyChanged);
    html += `</div>`;
  }
  $("#cmp-body").innerHTML = html;
  $("#cmp-results").classList.remove("hidden");
  updateExport();
}

// --- delegated events on the results body ----------------------------------
$("#cmp-body").addEventListener("input", (e) => {
  if (e.target.classList.contains("cmp-edit")) recordEdit(e.target);
});
$("#cmp-body").addEventListener("click", (e) => {
  const btn = e.target.closest(".cmp-copy");
  if (!btn) return;
  const inp = btn.closest(".diff-row").querySelector(".cmp-edit");
  if (inp) { inp.value = btn.dataset.a; recordEdit(inp); }
});

// --- export edited B -------------------------------------------------------
$("#cmp-export").onclick = async () => {
  const b = fileB.files[0];
  if (!b || !edits.size) return;
  const btn = $("#cmp-export");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Exporting…";
  try {
    const fd = new FormData();
    fd.append("save_b", b);
    fd.append("edits", JSON.stringify([...edits.values()]));
    const r = await fetch("/api/diff_apply", { method: "POST", body: fd });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "export failed"); }
    const blob = await r.blob();
    const base = b.name.toLowerCase().endsWith(".sav") ? b.name.slice(0, -4) : b.name;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.edited.sav`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    $("#cmp-error").textContent = err.message;
    $("#cmp-error").classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
};
