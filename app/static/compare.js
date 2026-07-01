"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fileA = $("#file-a"), fileB = $("#file-b"), goBtn = $("#go");
let lastDiff = null;
// reuse the editor's language choice (EN/DE); fall back to English
const LANG = localStorage.getItem("lang") || "en";
const nameOf = (e) => (e.loc && (e.loc[LANG] || e.loc.en)) || e.name || e.key;

function ready() { goBtn.disabled = !(fileA.files[0] && fileB.files[0]); }
fileA.onchange = ready;
fileB.onchange = ready;

goBtn.onclick = async () => {
  const a = fileA.files[0], b = fileB.files[0];
  if (!a || !b) return;
  $("#cmp-error").classList.add("hidden");
  $("#cmp-results").classList.add("hidden");
  $("#cmp-loading").classList.remove("hidden");
  goBtn.disabled = true;
  try {
    const fd = new FormData();
    fd.append("save_a", a);
    fd.append("save_b", b);
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

// category display order (matches savediff.CATEGORIES)
const ORDER = ["quests", "flags", "attributes", "skills", "inventory"];

function rows(cat, onlyChanged) {
  let html = "";
  const sec = (title, list, cls, fmt) => {
    if (!list || !list.length) return;
    html += `<div class="diff-sub">${title} (${list.length})</div>`;
    html += list.map(fmt).join("");
  };
  if (!onlyChanged) {
    sec("Added", cat.added, "add", e =>
      `<div class="diff-row add"><span class="k">${esc(nameOf(e))}</span><span class="v">${esc(e.b)}</span></div>`);
    sec("Removed", cat.removed, "rem", e =>
      `<div class="diff-row rem"><span class="k">${esc(nameOf(e))}</span><span class="v">${esc(e.a)}</span></div>`);
  }
  sec("Changed", cat.changed, "chg", e =>
    `<div class="diff-row chg"><span class="k">${esc(nameOf(e))}</span>` +
    `<span class="v">${esc(e.a)}</span><span class="arrow">→</span><span class="v">${esc(e.b)}</span></div>`);
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
    html += `<div class="diff-grp"><h3>${esc(cat.label)} ${badge}</h3>`;
    if (cat.error) html += `<div class="empty">could not read: ${esc(cat.error)}</div>`;
    else if (!shown) html += `<div class="empty">no ${onlyChanged ? "changes" : "differences"}</div>`;
    else html += rows(cat, onlyChanged);
    html += `</div>`;
  }
  $("#cmp-body").innerHTML = html;
  $("#cmp-results").classList.remove("hidden");
}
