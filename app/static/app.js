"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let session = null;            // {token, filename, states}
let lastLoad = null;           // last /api/load response, for re-render on language toggle
let loadedFile = null;         // cached File for silent session recovery (re-upload)
let quests = [];               // [{id, key, name, state}]
let attributes = [];           // [{id, set, name, label, value, tab, advanced}]
let skills = [];               // [{id, label, category, tier, tiers}]
let inventory = [];            // [{id, item, label, count}]
let itemDb = [];               // [{id, label, category}] valid items from the save
const invAdds = [];            // [{item, label, count}] queued new items to add
let npcs = [];                 // [{id,name,role,area,human,hp,maxhp,attitude}]
let npcSel = null;             // selected npc id
let npcSub = "profile";        // active sub-tab
const npcCache = {};           // id -> detail {stats, inventory, attitude}
const npcStatChanges = new Map(); // "id base_off" -> value
const npcLocationChanges = new Map(); // id -> {x, y, z}
const npcInvChanges = new Map();
const npcInvAdds = [];
const npcEquip = new Map();
const npcTradeChanges = new Map();
const npcTradeAdds = [];  // "id off" -> value
let passages = [];             // [{name, value}] world/story script flags
let passageDb = [];            // [{name, label, category}] full curated flag catalog
const passChanges = new Map(); // name -> int
const passAdds = [];           // [{name, value}] queued new flags to add
let behaviours = [];           // [{npc, role, status, detail}] read-only
let crimes = [];               // [{criminal, guild, guild_label, count, active}]
const crimeForgive = new Set(); // "criminal|guild" groups to forgive
const questChanges = new Map();  // id -> new_state
const attrChanges = new Map();   // id -> number
const skillChanges = new Map();  // id -> new_tier
const invChanges = new Map();    // id -> number

// ---------------------------------------------------------------- language
// Every server entity carries a `loc:{en,de}`. We don't touch the render code:
// instead we write the chosen language into the `.label`/`.name` the renderers
// already read, and re-apply on toggle. `loc[LANG]` always falls back to the
// English/raw label server-side, so nothing renders blank.
let LANG = localStorage.getItem("lang") || "en";
const nm = (x) => (x && x.loc && x.loc[LANG]) || (x && (x.label ?? x.name)) || "";

function normDetail(d) {            // a lazily-fetched NPC detail object
  if (!d) return d;
  d.name = nm(d);
  (d.inventory || []).forEach(it => it.label = nm(it));
  (d.trade || []).forEach(it => it.label = nm(it));
  (d.stats || []).forEach(st => st.label = nm(st));
  return d;
}

// weapon stat line (e.g. "110 Dmg / 95 Str") shown small between name and id
function statBadge(s) {
  if (!s || s.damage == null) return "";
  const attr = (s.requirement_attribute || "").charAt(0)
    + (s.requirement_attribute || "").slice(1).toLowerCase();   // STR -> Str
  const req = s.requirement ? ` / ${s.requirement} ${esc(attr)}` : "";
  return `<small class="stat">${s.damage} Dmg${req}</small>`;
}

function applyLang() {
  inventory.forEach(x => x.label = nm(x));
  itemDb.forEach(x => x.label = nm(x));
  attributes.forEach(x => x.label = nm(x));
  skills.forEach(x => x.label = nm(x));
  quests.forEach(x => x.name = nm(x));
  npcs.forEach(x => x.name = nm(x));
  for (const id in npcCache) normDetail(npcCache[id]);
}

function setLang(lang) {
  LANG = lang; localStorage.setItem("lang", lang);
  $$("#lang-pick button").forEach(b => b.classList.toggle("active", b.dataset.lang === lang));
  document.documentElement.lang = lang;
  if (session) { applyLang(); showEditor(lastLoad); }
}

// ---------------------------------------------------------------- upload
const drop = $("#drop"), fileInput = $("#file");
$("#browse").onclick = () => fileInput.click();
drop.onclick = (e) => { if (e.target.tagName !== "BUTTON" && !e.target.closest("a")) fileInput.click(); };
fileInput.onchange = () => fileInput.files[0] && upload(fileInput.files[0]);
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

async function upload(file) {
  loadedFile = file;                       // keep it for silent session recovery
  $("#load-error").classList.add("hidden");
  $("#loading").classList.remove("hidden");
  const fd = new FormData(); fd.append("save", file);
  try {
    const r = await fetch("/api/load", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to read save");
    session = { token: j.token, filename: j.filename, states: j.states };
    quests = j.quests; attributes = j.attributes || []; skills = j.skills || [];
    inventory = j.inventory || [];
    itemDb = j.item_db || []; invAdds.length = 0;
    passages = j.passages || []; passAdds.length = 0; passageDb = j.passage_db || [];
    npcs = j.npcs || []; npcSel = null; npcSub = "profile";
    for (const k in npcCache) delete npcCache[k];
    npcStatChanges.clear(); npcLocationChanges.clear(); npcInvChanges.clear(); npcInvAdds.length = 0; npcEquip.clear(); npcTradeChanges.clear(); npcTradeAdds.length = 0;
    behaviours = j.behaviours || [];
    crimes = j.crimes || []; crimeForgive.clear();
    questChanges.clear(); attrChanges.clear(); skillChanges.clear(); invChanges.clear(); passChanges.clear();
    lastLoad = j; applyLang();
    showEditor(j);
  } catch (e) {
    $("#load-error").textContent = "⚠ " + e.message;
    $("#load-error").classList.remove("hidden");
  } finally {
    $("#loading").classList.add("hidden");
  }
}

// Silent session recovery. The server only keeps the decompressed save in memory
// for a few minutes; if it has expired we re-upload the cached file to get a fresh
// token. The save bytes are identical, so every offset-based id — and therefore all
// pending edits — stays valid. We update only the token and leave edit state alone.
async function reauth() {
  if (!loadedFile) throw new Error("session expired — please re-upload your save");
  const fd = new FormData(); fd.append("save", loadedFile);
  const r = await fetch("/api/load", { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "session recovery failed");
  session.token = j.token;
}

// ---------------------------------------------------------------- editor
function showEditor(j) {
  $("#upload-card").classList.add("hidden");
  $("#edit-card").classList.remove("hidden");
  $("#bar").classList.remove("hidden");
  $("#save-name").textContent = j.filename;
  computeGlossCats();
  const gl = quests.filter(isGlossary).length;
  $("#save-meta").textContent =
    (j.slot ? `“${j.slot}”  ·  ` : "") +
    `${attributes.length} attributes · ${inventory.length} items · ${quests.length - gl} quests · ${gl} glossary`;
  renderAttrs("character"); renderSkills();
  renderInventory(); renderNpcList(); renderNpcDetail(); renderPassages(); renderBehaviours(); renderCrimes();
  renderGlossaryTabs(); renderQuests();
  updateBar();
}

$("#reset").onclick = () => location.reload();

$$(".tab").forEach(t => t.onclick = () => {
  $$(".tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $$(".panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== t.dataset.tab));
});
$("#adv-toggle").onchange = () => renderAttrs("character");

// language picker (EN/DE) — set initial active state, bind clicks
$$("#lang-pick button").forEach(b => {
  b.classList.toggle("active", b.dataset.lang === LANG);
  b.onclick = () => setLang(b.dataset.lang);
});
document.documentElement.lang = LANG;

// ---------------------------------------------------------------- attributes
const setLabel = (s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");

function renderAttrs(tab) {
  const showAdv = $("#adv-toggle").checked;
  const items = attributes.filter(a =>
    a.tab === tab && (tab !== "character" || showAdv || !a.advanced));
  const groups = {};
  items.forEach(a => (groups[a.set] ??= []).push(a));
  const el = $(`#attrs-${tab}`);
  if (!items.length) { el.innerHTML = `<div class="empty">no editable values</div>`; return; }
  el.innerHTML = Object.entries(groups).map(([set, list]) => `
    <div class="grp">
      <h3>${esc(setLabel(set))}</h3>
      <div class="grid">${list.map(attrRow).join("")}</div>
    </div>`).join("");
  el.querySelectorAll("input[data-id]").forEach(i => i.oninput = onAttr);
}

function attrRow(a) {
  const val = attrChanges.has(a.id) ? attrChanges.get(a.id) : a.value;
  return `<div class="attr ${attrChanges.has(a.id) ? "changed" : ""}">
    <label title="${esc(a.name)}">${esc(a.label)}</label>
    <input type="number" step="any" data-id="${a.id}" data-orig="${a.value}" value="${val}">
  </div>`;
}

function onAttr(e) {
  const id = +e.target.dataset.id, orig = parseFloat(e.target.dataset.orig);
  const v = e.target.value;
  if (v === "" || parseFloat(v) === orig) attrChanges.delete(id);
  else attrChanges.set(id, parseFloat(v));
  e.target.closest(".attr").classList.toggle("changed", attrChanges.has(id));
  updateBar();
}

// ---------------------------------------------------------------- skills
function renderSkills() {
  const el = $("#skills-list");
  if (!skills.length) { el.innerHTML = `<div class="empty">no skills found</div>`; return; }
  const groups = {};
  skills.forEach(s => (groups[s.category] ??= []).push(s));
  el.innerHTML = Object.entries(groups).map(([cat, list]) =>
    `<div class="grp"><h3>${esc(cat)}</h3><div class="grid">${list.map(skillRow).join("")}</div></div>`
  ).join("") +
    `<p class="muted">Tier changes &amp; <b>Untrained (unlearn)</b> edit the effect in place.
     <b>“(learn)”</b> options are <b>experimental</b> — they clone an effect spec and retarget it,
     so verify in-game.</p>`;
  el.querySelectorAll("select[data-skill]").forEach(s => s.onchange = onSkill);
}

function skillRow(s) {
  const sel = skillChanges.get(s.id) ?? s.tier;
  const opts = s.tiers.map(o =>
    `<option value="${o.value}" ${o.value === sel ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  return `<div class="attr skillrow ${skillChanges.has(s.id) ? "changed" : ""} ${s.learned ? "" : "fresh"}">
    <label title="${esc(s.category)}">${esc(s.label)}${s.learned ? "" : ` <span class="tag">not learned</span>`}</label>
    <select data-skill="${s.id}">${opts}</select>
  </div>`;
}

function onSkill(e) {
  const id = e.target.dataset.skill;          // string fid (numeric for learned, "new:…" for learnable)
  const s = skills.find(x => x.id === id);
  if (e.target.value === s.tier) skillChanges.delete(id);
  else skillChanges.set(id, e.target.value);
  e.target.closest(".attr").classList.toggle("changed", skillChanges.has(id));
  updateBar();
}

// ---------------------------------------------------------------- inventory
$("#search-inv").oninput = renderInventory;
$("#only-changed-inv").onchange = renderInventory;

let _addUid = 0;

// queue a NEW stack of an item (qty 1). Each call adds a separate entry, so
// clicking "Arrow" twice queues two independent stacks you can each set to 99.
function addItemToQueue(key) {
  if (!key || !/^[A-Za-z0-9_]{2,80}$/.test(key)) return null;
  const known = itemDb.find(it => it.id === key);
  const entry = { uid: ++_addUid, item: key, label: known ? known.label : key,
                  count: 1, known: !!known };
  invAdds.push(entry);
  renderInventory(); updateBar();
  return entry;
}

// -------- reusable picker modal (items + passages/gates) --------
// cfg: {title, placeholder, status, items:[{key,label,category}],
//       badge:(key)->string, onPick:(key)->statusString|null}
let _picker = null, pickerCat = "All";
const pickerModal = $("#picker-modal");

$("#picker-search").oninput = renderPickerItems;
pickerModal.querySelectorAll("[data-close]").forEach(el => el.onclick = closePicker);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !pickerModal.classList.contains("hidden")) closePicker();
});

function openPicker(cfg) {
  _picker = cfg; pickerCat = "All";
  $("#picker-title").textContent = cfg.title;
  $("#picker-search").value = "";
  $("#picker-search").placeholder = cfg.placeholder || "Filter…";
  $("#picker-status").textContent = cfg.status || "";
  renderPickerCats(); renderPickerItems();
  pickerModal.classList.remove("hidden"); pickerModal.setAttribute("aria-hidden", "false");
  $("#picker-search").focus();
}
function closePicker() {
  pickerModal.classList.add("hidden"); pickerModal.setAttribute("aria-hidden", "true");
  _picker = null;
}

function renderPickerCats() {
  const counts = {};
  _picker.items.forEach(it => { counts[it.category] = (counts[it.category] || 0) + 1; });
  const row = (name, n) =>
    `<button class="cat-btn ${name === pickerCat ? "active" : ""}" data-cat="${esc(name)}">
       <span>${esc(name)}</span><span class="cat-n">${n}</span></button>`;
  $("#picker-cats").innerHTML =
    row("All", _picker.items.length) + Object.keys(counts).sort().map(c => row(c, counts[c])).join("");
  $("#picker-cats").querySelectorAll(".cat-btn").forEach(b => b.onclick = () => {
    pickerCat = b.dataset.cat; renderPickerCats(); renderPickerItems();
  });
}

function renderPickerItems() {
  const q = $("#picker-search").value.trim().toLowerCase();
  const list = _picker.items.filter(it =>
    (pickerCat === "All" || it.category === pickerCat) &&
    (!q || it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)));

  $("#picker-items").innerHTML = list.length
    ? list.map(it => {
        const b = _picker.badge(it.key);
        return `<button class="pick ${b && b !== "＋" ? "picked" : ""}" data-key="${esc(it.key)}" title="${esc(it.key)}">
          <span class="pick-name">${esc(it.label)}${statBadge(it.stats)}<small>${esc(it.key)}</small></span>
          <span class="pick-add">${esc(b)}</span>
        </button>`;
      }).join("")
    : `<div class="empty">nothing matches</div>`;

  $("#picker-items").querySelectorAll(".pick").forEach(el => el.onclick = () => {
    const status = _picker.onPick(el.dataset.key);
    if (_picker.closeOnPick) { closePicker(); return; }
    const b = _picker.badge(el.dataset.key);
    el.classList.toggle("picked", !!b && b !== "＋");
    el.querySelector(".pick-add").textContent = b;
    if (status) $("#picker-status").textContent = status;
  });
}

// item picker
$("#open-item-picker").onclick = () => {
  if (!itemDb.length) { toast("no item catalog loaded"); return; }
  openPicker({
    title: "Select an item",
    placeholder: "Filter items… (name or key)",
    status: "Click an item to add it. Click again to add more.",
    items: itemDb.map(it => ({ key: it.id, label: it.label, category: it.category, stats: it.stats })),
    badge: (k) => { const n = invAdds.filter(x => x.item === k).length; return n ? `×${n}` : "＋"; },
    onPick: (k) => { const a = addItemToQueue(k); const n = invAdds.filter(x => x.item === k).length;
      return a && `Added ${a.label} — ${n} stack${n > 1 ? "s" : ""} queued (set each amount in the list)`; },
  });
};

// passage / gate picker — shows flags NOT already in this save
$("#open-pass-picker").onclick = () => {
  const present = new Set(passages.map(p => p.name));
  const avail = passageDb.filter(p => !present.has(p.name));
  if (!avail.length) { toast(passageDb.length ? "every known flag is already in this save" : "no flag catalog loaded"); return; }
  openPicker({
    title: "Add a flag / gate",
    placeholder: "Filter flags… (name)",
    status: `${avail.length} flags not in this save — click to add (value 1), adjust below`,
    items: avail.map(p => ({ key: p.name, label: p.label, category: p.category })),
    badge: (k) => passAdds.some(a => a.name === k) ? "✓" : "＋",
    onPick: (k) => { const added = togglePassQueue(k); return added ? `Added ${k} (value 1) — set the value below` : `Removed ${k}`; },
  });
};

function renderInventory() {
  const q = $("#search-inv").value.trim().toLowerCase();
  const onlyChanged = $("#only-changed-inv").checked;
  const el = $("#list-inv");

  const adds = invAdds.map(a => `<div class="attr added">
      <label title="${esc(a.item)}">+ ${esc(a.label)}${a.known ? "" : ` <span class="tag">new key</span>`}<small>${esc(a.item)}</small></label>
      <input type="number" step="1" min="1" data-add="${a.uid}" value="${a.count}">
      <button type="button" class="link rm" data-rm="${a.uid}" title="remove">✕</button>
    </div>`).join("");

  const rows = inventory.filter(it => (!onlyChanged || invChanges.has(it.id))
    && (!q || it.label.toLowerCase().includes(q) || it.item.toLowerCase().includes(q)));
  rows.sort((a, b) => b.count - a.count);
  $("#count-inv").textContent = `${rows.length} shown${invAdds.length ? ` · ${invAdds.length} to add` : ""}`;

  const items = rows.slice(0, 800).map(it => {
    const val = invChanges.has(it.id) ? invChanges.get(it.id) : it.count;
    return `<div class="attr ${invChanges.has(it.id) ? "changed" : ""}">
      <label title="${esc(it.item)}">${esc(it.label)}${statBadge(it.stats)}<small>${esc(it.item)}</small></label>
      <input type="number" step="1" min="0" data-inv="${it.id}" data-orig="${it.count}" value="${val}">
    </div>`;
  }).join("");

  el.innerHTML = (adds ? `<div class="grid">${adds}</div>` : "")
    + (rows.length ? `<div class="grid">${items}</div>` : (adds ? "" : `<div class="empty">no matching items</div>`))
    + (rows.length > 800 ? `<div class="empty">…${rows.length - 800} more — refine search</div>` : "");

  el.querySelectorAll("input[data-inv]").forEach(i => i.oninput = onInvPick);
  el.querySelectorAll("input[data-add]").forEach(i => i.oninput = (e) => {
    const a = invAdds.find(x => x.uid === +e.currentTarget.dataset.add);
    if (a) a.count = Math.max(1, Math.floor(+e.currentTarget.value || 1));
  });
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = (e) => {
    const uid = +e.currentTarget.dataset.rm;
    const idx = invAdds.findIndex(x => x.uid === uid);
    if (idx >= 0) invAdds.splice(idx, 1);
    renderInventory(); updateBar();
  });
}

function onInvPick(e) {
  const id = +e.target.dataset.inv, orig = +e.target.dataset.orig, v = e.target.value;
  if (v === "" || +v === orig) invChanges.delete(id);
  else invChanges.set(id, Math.max(0, Math.floor(+v)));
  e.target.closest(".attr").classList.toggle("changed", invChanges.has(id));
  updateBar();
}

// ---------------------------------------------------------------- passages (script flags)
$("#search-pass").oninput = renderPassages;
$("#only-changed-pass").onchange = renderPassages;

// queue/unqueue a flag from the catalog (added with value 1); returns true if added
function togglePassQueue(name) {
  if (passages.some(p => p.name === name)) { toast("that flag is already in this save"); return false; }
  const i = passAdds.findIndex(a => a.name === name);
  if (i >= 0) { passAdds.splice(i, 1); renderPassages(); updateBar(); return false; }
  passAdds.push({ name, value: 1 });
  renderPassages(); updateBar();
  return true;
}

// group present flags by their catalog category (Permission/Passage first)
function passCat(name) {
  const e = passageDb.find(p => p.name === name);
  if (e) return e.category;
  return /Warning|Permis/i.test(name) ? "Permission / Passage" : "NPC / Dialogue";
}
function passOrder(cats) {
  return cats.sort((a, b) =>
    (b === "Permission / Passage") - (a === "Permission / Passage") || a.localeCompare(b));
}

// catalog metadata for a flag ({label, category, type, values, examples, note})
function passMeta(name) { return passageDb.find(p => p.name === name) || {}; }

// suggested values for a flag's editable dropdown. The <input> stays a free number
// field, so any custom value is still allowed — these are only the quick-pick options.
function passOptions(name, cur) {
  const m = passMeta(name);
  let opts = Array.isArray(m.values) ? m.values.slice() : (m.type === "bool" ? [0, 1] : []);
  if (Array.isArray(m.examples)) opts = opts.concat(m.examples);   // real values seen in saves
  if (cur !== "" && cur != null && !Number.isNaN(+cur)) opts.push(Math.trunc(+cur));
  if (!opts.length) opts = [0, 1];
  return [...new Set(opts.map(Number))].sort((a, b) => a - b);
}

// Editable dropdown: one shared popover lists ALL options for the focused input, while
// the <input> itself stays a free number field (custom values allowed). A native
// <datalist> can't do this — on a pre-filled field it filters options to the current text.
let _combo;
function comboPop() {
  if (_combo) return _combo;
  _combo = document.createElement("div");
  _combo.className = "combo-pop hidden";
  document.body.appendChild(_combo);
  _combo.addEventListener("mousedown", (e) => {   // mousedown fires before input blur
    const b = e.target.closest("[data-val]");
    if (!b || !_combo._input) return;
    e.preventDefault();
    _combo._input.value = b.dataset.val;
    _combo._input.dispatchEvent(new Event("input", { bubbles: true }));
    hideCombo();
  });
  window.addEventListener("scroll", hideCombo, true);
  window.addEventListener("resize", hideCombo);
  return _combo;
}
function showCombo(input) {
  const opts = (input.dataset.opts || "").split(",").filter(x => x !== "");
  if (!opts.length) return;
  const pop = comboPop();
  pop._input = input;
  pop.innerHTML = opts.map(o =>
    `<button type="button" data-val="${esc(o)}" class="${String(o) === String(input.value) ? "sel" : ""}">${esc(o)}</button>`
  ).join("");
  const r = input.getBoundingClientRect();
  pop.style.left = r.left + "px";
  pop.style.top = (r.bottom + 2) + "px";
  pop.style.minWidth = r.width + "px";
  pop.classList.remove("hidden");
}
function hideCombo() { if (_combo) { _combo.classList.add("hidden"); _combo._input = null; } }

function passRow(p) {
  const val = passChanges.has(p.name) ? passChanges.get(p.name) : p.value;
  const m = passMeta(p.name);
  const opts = passOptions(p.name, val).join(",");
  const hint = m.type ? ` <span class="tag">${esc(m.type)}</span>` : "";
  const title = m.label ? `${esc(m.label)}${m.note ? " — " + esc(m.note) : ""}` : esc(p.name);
  return `<div class="attr ${passChanges.has(p.name) ? "changed" : ""}">
    <label title="${title}">${esc(p.name)}${hint}</label>
    <input type="number" step="1" class="combo" data-opts="${esc(opts)}" data-pass="${esc(p.name)}" data-orig="${p.value}" value="${val}">
  </div>`;
}

function renderPassages() {
  const q = $("#search-pass").value.trim().toLowerCase();
  const onlyChanged = $("#only-changed-pass").checked;
  const el = $("#list-pass");
  const match = p => !q || p.name.toLowerCase().includes(q)
    || (passMeta(p.name).label || "").toLowerCase().includes(q);
  const rows = passages.filter(p => (!onlyChanged || passChanges.has(p.name)) && match(p));
  $("#count-pass").textContent = `${rows.length} shown${passAdds.length ? ` · ${passAdds.length} to add` : ""}`;

  const adds = passAdds.map((a, i) => `<div class="attr added">
      <label title="${esc(a.name)}">+ ${esc(a.name)}</label>
      <input type="number" step="1" class="combo" data-opts="${esc(passOptions(a.name, a.value).join(","))}" data-padd="${i}" value="${a.value}">
      <button type="button" class="link rm" data-prm="${i}" title="remove">✕</button>
    </div>`).join("");

  const groups = {};
  rows.forEach(p => (groups[passCat(p.name)] ??= []).push(p));
  let html = adds ? `<div class="grp"><h3>To add — new flags (experimental)</h3><div class="grid">${adds}</div></div>` : "";
  html += passOrder(Object.keys(groups)).map(cat =>
    `<div class="grp"><h3>${esc(cat)}</h3><div class="grid">${groups[cat].slice(0, 1000).map(passRow).join("")}</div></div>`
  ).join("");
  el.innerHTML = html || `<div class="empty">no matching flags</div>`;

  el.querySelectorAll("input.combo").forEach(i => {
    i.addEventListener("focus", () => showCombo(i));
    i.addEventListener("click", () => showCombo(i));
    i.addEventListener("blur", () => setTimeout(hideCombo, 120));
  });
  el.querySelectorAll("input[data-pass]").forEach(i => i.oninput = onPassPick);
  el.querySelectorAll("input[data-padd]").forEach(i => i.oninput = (e) => {
    passAdds[+e.currentTarget.dataset.padd].value = Math.trunc(+e.currentTarget.value || 0);
  });
  el.querySelectorAll("[data-prm]").forEach(b => b.onclick = (e) => {
    passAdds.splice(+e.currentTarget.dataset.prm, 1); renderPassages(); updateBar();
  });
}

function onPassPick(e) {
  const name = e.currentTarget.dataset.pass, orig = +e.currentTarget.dataset.orig, v = e.currentTarget.value;
  if (v === "" || +v === orig) passChanges.delete(name);
  else passChanges.set(name, Math.trunc(+v));
  e.currentTarget.closest(".attr").classList.toggle("changed", passChanges.has(name));
  updateBar();
}

// ---------------------------------------------------------------- behaviour (read-only)
$("#search-behave").oninput = renderBehaviours;

function renderBehaviours() {
  const q = $("#search-behave").value.trim().toLowerCase();
  const el = $("#list-behave");
  const rows = behaviours.filter(b => !q
    || (b.npc + " " + b.role + " " + b.status + " " + b.detail).toLowerCase().includes(q));
  $("#count-behave").textContent = `${rows.length} shown`;
  if (!rows.length) { el.innerHTML = `<div class="empty">no NPCs with a set attitude</div>`; return; }
  el.innerHTML = rows.map(b => `<div class="row">
    <div class="name">${esc(b.npc)}<small>${esc(b.role)}${b.role ? " · " : ""}${esc(b.detail)}</small></div>
    <span class="bstat ${esc(b.status)}">${esc(b.status)}</span>
  </div>`).join("");
}

// ---------------------------------------------------------------- crimes (forgive)
$("#search-crime").oninput = renderCrimes;

function renderCrimes() {
  const q = $("#search-crime").value.trim().toLowerCase();
  const el = $("#list-crime");
  const rows = crimes.filter(c => !q
    || (c.criminal + " " + c.guild + " " + c.guild_label).toLowerCase().includes(q));
  $("#count-crime").textContent = `${rows.length} shown${crimeForgive.size ? ` · ${crimeForgive.size} to forgive` : ""}`;
  if (!rows.length) { el.innerHTML = `<div class="empty">no crimes</div>`; return; }
  el.innerHTML = rows.map(c => {
    const key = c.criminal + "|" + c.guild;
    const on = crimeForgive.has(key);
    return `<div class="row ${on ? "changed" : ""}">
      <div class="name">${esc(c.criminal)}<small>vs ${esc(c.guild_label)} · ${c.active} active / ${c.count} total</small></div>
      <span class="bstat ${c.active ? "Hostile" : "Downed"}">${c.active ? c.active + " active" : "clear"}</span>
      <label class="check"><input type="checkbox" data-crime="${esc(key)}" ${on ? "checked" : ""} ${c.active ? "" : "disabled"}> forgive</label>
    </div>`;
  }).join("");
  el.querySelectorAll("input[data-crime]").forEach(i => i.onchange = (e) => {
    const k = e.currentTarget.dataset.crime;
    e.currentTarget.checked ? crimeForgive.add(k) : crimeForgive.delete(k);
    e.currentTarget.closest(".row").classList.toggle("changed", e.currentTarget.checked);
    updateBar();
  });
}

// ---------------------------------------------------------------- quests + glossary
// glossaries share one structure: Quest_<root> > <Name>Glossary > Unlock + Entry…
// categories are detected from the save (so new ones appear automatically).
let glossCats = [];          // [{root, label}]
let activeGloss = null;      // active sub-tab root
const shortKey = (q) => q.key.split(".").pop();

function computeGlossCats() {
  const keyset = new Set(quests.map(shortKey));
  const roots = new Set();
  for (const k of keyset) {                 // a group overview = "<root>_<Name>Glossary" whose <root> is itself a quest
    if (!k.endsWith("Glossary")) continue;
    const i = k.lastIndexOf("_");
    if (i > 0 && keyset.has(k.slice(0, i))) roots.add(k.slice(0, i));
  }
  glossCats = [...roots].sort().map(root => ({
    root, label: root.replace(/^Quest_/, "").replace(/Glossary$/, "")
  }));
  if (!glossCats.some(c => c.root === activeGloss)) activeGloss = glossCats[0]?.root ?? null;
}

const glossCat = (q) => {
  const k = shortKey(q);
  let best = null;
  for (const c of glossCats)
    if ((k === c.root || k.startsWith(c.root + "_")) && (!best || c.root.length > best.root.length)) best = c;
  return best;
};
const isGlossary = (q) => glossCat(q) !== null;
function glossGroup(q) {                 // "<Name>Glossary" within its category, or null for the root
  const c = glossCat(q); if (!c) return null;
  const k = shortKey(q);
  if (k === c.root) return null;
  const rem = k.slice(c.root.length + 1);
  const i = rem.indexOf("Glossary");
  return i < 0 ? null : rem.slice(0, i + "Glossary".length);
}
const glossGroupLabel = (g) => g.replace(/Glossary$/, "");
function glossEntryLabel(q, c, g) {
  const k = shortKey(q), pre = c.root + "_" + g;
  return k.slice(pre.length + 1).replace(/([a-z])([A-Z0-9])/g, "$1 $2");
}

$("#search-quests").oninput = () => renderQuestPanel("quests");
$("#only-changed-quests").onchange = () => renderQuestPanel("quests");
$("#search-glossary").oninput = renderGlossaryPanel;
$("#only-changed-glossary").onchange = renderGlossaryPanel;

function renderQuests() { renderQuestPanel("quests"); renderGlossaryPanel(); }

const questOpts = (sel) => session.states.map(s =>
  `<option ${s === sel ? "selected" : ""}>${s}</option>`).join("");

function questRow(it, name) {
  const sel = questChanges.get(it.id) ?? it.state;
  return `<div class="row ${questChanges.has(it.id) ? "changed" : ""}">
    <div class="name" title="${esc(it.key)}">${esc(shortKey(it))}<small>${esc(name ?? it.name)}</small></div>
    <span class="st ${it.state}">${it.state}</span><span class="arrow">→</span>
    <select data-id="${it.id}">${questOpts(sel)}</select>
  </div>`;
}

function renderQuestPanel(tab) {
  const q = $(`#search-${tab}`).value.trim().toLowerCase();
  const onlyChanged = $(`#only-changed-${tab}`).checked;
  const list = $(`#list-${tab}`);
  const rows = quests.filter(it => !isGlossary(it)
    && (!onlyChanged || questChanges.has(it.id))
    && (!q || it.key.toLowerCase().includes(q)));
  $(`#count-${tab}`).textContent = `${rows.length} shown`;
  if (!rows.length) { list.innerHTML = `<div class="empty">no matching quests</div>`; return; }
  list.innerHTML = rows.slice(0, 600).map(it => questRow(it)).join("")
    + (rows.length > 600 ? `<div class="empty">…and ${rows.length - 600} more — refine your search</div>` : "");
  list.querySelectorAll("select").forEach(s => s.onchange = onQuestPick);
}

const openGloss = new Set();
const effState = (it) => questChanges.has(it.id) ? questChanges.get(it.id) : it.state;

function glossRow(it, name, state, disabled) {
  const opts = session.states.map(s => `<option ${s === state ? "selected" : ""}>${s}</option>`).join("");
  return `<div class="row ${questChanges.has(it.id) ? "changed" : ""} ${disabled ? "locked" : ""}">
    <div class="name" title="${esc(it.key)}">${esc(name)}<small>${esc(it.key)}</small></div>
    <span class="st ${it.state}">${it.state}</span><span class="arrow">→</span>
    <select data-id="${it.id}" ${disabled ? "disabled" : ""}>${opts}</select>
  </div>`;
}

// derive the locked nodes (group overviews + each category root) from their
// children, over the FULL set (so search/filter never skews the result).
function deriveGlossary() {
  for (const c of glossCats) {
    const inCat = quests.filter(it => glossCat(it) === c);
    const root = inCat.find(it => shortKey(it) === c.root);
    const byGroup = new Map();
    inCat.forEach(it => { const g = glossGroup(it); if (g) (byGroup.get(g) || byGroup.set(g, []).get(g)).push(it); });

    let anyChildEdited = false;
    const groupOv = [];
    for (const [g, list] of byGroup) {
      const overview = list.find(it => shortKey(it) === c.root + "_" + g);
      const unlock = list.find(it => it.key.endsWith("Unlock"));
      const entries = list.filter(it => it !== overview && it !== unlock);
      const childEdited = [unlock, ...entries].some(it => it && questChanges.has(it.id));
      if (childEdited) anyChildEdited = true;
      let ov = overview ? overview.state : "Succeeded";
      if (overview) {
        if (childEdited) {
          const unlocked = unlock ? effState(unlock) === "Succeeded" : true;
          ov = (unlocked && entries.every(e => effState(e) === "Succeeded")) ? "Succeeded" : "Available";
          ov === overview.state ? questChanges.delete(overview.id) : questChanges.set(overview.id, ov);
        } else { questChanges.delete(overview.id); ov = overview.state; }
      }
      groupOv.push(ov);
    }
    if (root) {
      if (anyChildEdited) {
        const rd = groupOv.every(s => s === "Succeeded") ? "Succeeded" : "Available";
        rd === root.state ? questChanges.delete(root.id) : questChanges.set(root.id, rd);
      } else questChanges.delete(root.id);
    }
  }
}

function renderGlossaryTabs() {
  const nav = $("#gloss-subtabs");
  nav.innerHTML = glossCats.length < 2 ? "" : glossCats.map(c =>
    `<button class="subtab ${c.root === activeGloss ? "active" : ""}" data-cat="${esc(c.root)}">${esc(c.label)}</button>`
  ).join("");
  nav.querySelectorAll(".subtab").forEach(b => b.onclick = () => {
    activeGloss = b.dataset.cat;
    renderGlossaryTabs(); renderGlossaryPanel();
  });
}

function renderGlossaryPanel() {
  deriveGlossary();                                   // derive ALL categories
  const c = glossCats.find(x => x.root === activeGloss) || glossCats[0];
  const el = $("#list-glossary");
  if (!c) { el.innerHTML = `<div class="empty">no glossary in this save</div>`; $("#count-glossary").textContent = ""; return; }

  const q = $("#search-glossary").value.trim().toLowerCase();
  const onlyChanged = $("#only-changed-glossary").checked;
  const match = it => (!onlyChanged || questChanges.has(it.id)) && (!q || it.key.toLowerCase().includes(q));
  const grank = (it, g) => it.key.endsWith("Unlock") ? 0 : (shortKey(it) === c.root + "_" + g ? 1 : 2);
  const expand = !!(q || onlyChanged);

  const inCat = quests.filter(it => glossCat(it) === c);
  const shown = inCat.filter(match);
  $("#count-glossary").textContent = `${shown.length} shown`;
  if (!shown.length) { el.innerHTML = `<div class="empty">no matching entries</div>`; return; }

  const root = inCat.find(it => shortKey(it) === c.root);
  const groups = new Map();
  shown.forEach(it => { const g = glossGroup(it); if (g) (groups.get(g) || groups.set(g, []).get(g)).push(it); });

  let html = (root && match(root)) ? glossRow(root, `${c.label} Glossary (auto)`, effState(root), true) : "";
  for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => grank(a, g) - grank(b, g));
    const overview = inCat.find(it => shortKey(it) === c.root + "_" + g);
    const unlock = inCat.find(it => glossGroup(it) === g && it.key.endsWith("Unlock"));
    const unlocked = unlock ? effState(unlock) === "Succeeded" : true;
    const full = inCat.filter(it => glossGroup(it) === g);
    const done = full.filter(it => effState(it) === "Succeeded").length;
    const changed = full.filter(it => questChanges.has(it.id)).length;
    const gid = c.root + "|" + g;
    const open = expand || openGloss.has(gid);
    const body = list.map(it =>
      it === overview ? glossRow(it, "Overview (auto)", effState(it), true)
        : it === unlock ? glossRow(it, "Unlock", effState(it), false)
          : glossRow(it, glossEntryLabel(it, c, g), effState(it), !unlocked)
    ).join("");
    html += `<details class="gloss"${open ? " open" : ""} data-g="${esc(gid)}">
      <summary>${esc(glossGroupLabel(g))} <span class="muted">${done}/${full.length}</span>
        ${changed ? `<span class="tag">${changed} changed</span>` : ""}</summary>
      <div class="gloss-body">${body}</div>
    </details>`;
  }
  el.innerHTML = html;
  el.querySelectorAll("select[data-id]:not([disabled])").forEach(s => s.onchange = onGlossaryPick);
  el.querySelectorAll("details.gloss").forEach(d =>
    d.ontoggle = () => { d.open ? openGloss.add(d.dataset.g) : openGloss.delete(d.dataset.g); });
}

function onGlossaryPick(e) {
  const id = +e.target.dataset.id;
  const it = quests.find(x => x.id === id);
  if (e.target.value === it.state) questChanges.delete(id);
  else questChanges.set(id, e.target.value);
  renderGlossaryPanel();          // re-derive overviews + root + entry gating
  updateBar();
}

function onQuestPick(e) {
  const id = +e.target.dataset.id;
  const it = quests.find(q => q.id === id);
  if (e.target.value === it.state) questChanges.delete(id);
  else questChanges.set(id, e.target.value);
  e.target.closest(".row").classList.toggle("changed", questChanges.has(id));
  updateBar();
}

// ---------------------------------------------------------------- NPCs
const ATT_CLASS = { Friendly: "Friendly", Angry: "Angry", Hostile: "Hostile",
  Execute: "Hostile", Downed: "Downed", Neutral: "Neutral", Default: "Other", Other: "Other" };

$("#search-npc").oninput = renderNpcList;
$("#npc-creatures").onchange = renderNpcList;

function renderNpcList() {
  const q = $("#search-npc").value.trim().toLowerCase();
  const withCreatures = $("#npc-creatures").checked;
  const rows = npcs.filter(n => (withCreatures || n.human)
    && (!q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)));
  $("#count-npc").textContent = `${rows.length} shown`;
  const npcEdited = (id) => [...npcStatChanges.keys(), ...npcInvChanges.keys()].some(k => k.startsWith(id + " "));
  $("#npc-list").innerHTML = rows.slice(0, 600).map(n => {
    const badge = n.dead
      ? `<span class="bstat Hostile">dead</span>`
      : (n.attitude && n.attitude !== "Default" ? `<span class="bstat ${ATT_CLASS[n.attitude] || "Other"}">${esc(n.attitude)}</span>` : "");
    return `<button class="npc-row ${n.id === npcSel ? "active" : ""} ${npcEdited(n.id) ? "edited" : ""} ${n.dead ? "dead" : ""}" data-id="${esc(n.id)}">
      <span class="npc-name">${esc(n.name)}${n.human ? "" : ` <span class="tag">creature</span>`}
        <small>${esc(n.role)}${n.area ? " · " + esc(n.area) : ""}${n.hp != null ? " · " + n.hp + "/" + n.maxhp + " HP" : ""}</small></span>
      ${badge}</button>`;
  }).join("") + (rows.length > 600 ? `<div class="empty">…${rows.length - 600} more — refine search</div>` : "")
    || `<div class="empty">no matching characters</div>`;
  $("#npc-list").querySelectorAll(".npc-row").forEach(b => b.onclick = () => selectNpc(b.dataset.id));
}

async function selectNpc(id) {
  npcSel = id; renderNpcList();
  if (!npcCache[id]) {
    $("#npc-detail").innerHTML = `<div class="empty"><span class="spinner"></span> loading…</div>`;
    try {
      const r = await fetch("/api/npc", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, id }) });
      if (r.status === 410) { await reauth(); return selectNpc(id); }
      npcCache[id] = normDetail(await r.json());
    } catch (e) { $("#npc-detail").innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; return; }
  }
  renderNpcDetail();
}

function renderNpcDetail() {
  const el = $("#npc-detail");
  if (!npcSel || !npcCache[npcSel]) { el.innerHTML = `<div class="empty">Select a character from the list to edit it.</div>`; return; }
  const d = npcCache[npcSel];
  const att = (d.dead ? `<span class="bstat Hostile">dead</span> ` : "")
    + (d.attitude && d.attitude !== "Default"
      ? `<span class="bstat ${ATT_CLASS[d.attitude] || "Other"}">${esc(d.attitude)}</span>`
      : `<span class="bstat Other">Default</span>`);
  const tab = (k, lbl) => `<button class="subtab ${npcSub === k ? "active" : ""}" data-sub="${k}">${lbl}</button>`;
  if (npcSub === "merchant" && !d.is_trader) npcSub = "inventory";   // tab hidden for non-traders
  if (npcSub === "location" && !d.location) npcSub = "profile";      // tab hidden when unavailable
  el.innerHTML = `
    <div class="npc-head">
      <div><h3>${esc(d.name)}</h3>
        <span class="muted">${esc(d.role)}${d.area ? " · " + esc(d.area) : ""} · <code>${esc(d.id)}</code></span></div>
      ${att}
    </div>
    <nav class="subtabs">${tab("profile", "Profile")}${d.location ? tab("location", "Location") : ""}${tab("inventory", "Inventory")}${d.is_trader ? tab("merchant", "Merchant") : ""}</nav>
    <div id="npc-sub" class="npc-subbody"></div>`;
  el.querySelectorAll(".subtab").forEach(b => b.onclick = () => { npcSub = b.dataset.sub; renderNpcDetail(); });
  renderNpcSub();
}

function renderNpcSub() {
  const d = npcCache[npcSel], el = $("#npc-sub");
  if (npcSub === "location") {
    const loc = d.location;
    const pending = npcLocationChanges.get(d.id) || loc;
    el.innerHTML = `<p class="muted">Saved current position. Coordinates are editable only when the save contains a valid <b>CharacterLocation</b> vector.</p>
      <div class="grid npc-grid">${["x", "y", "z"].map(axis => `<div class="attr ${npcLocationChanges.has(d.id) ? "changed" : ""}">
        <label>${axis.toUpperCase()}</label><input type="number" step="any" data-location="${axis}" data-orig="${loc[axis]}" value="${pending[axis]}"></div>`).join("")}</div>`;
    el.querySelectorAll("input[data-location]").forEach(i => i.oninput = onNpcLocation);
  } else if (npcSub === "profile") {
    const rows = d.stats.map(s => {
      const key = `${d.id} ${s.base_off}`;
      const val = npcStatChanges.has(key) ? npcStatChanges.get(key) : s.value;
      return `<div class="attr ${npcStatChanges.has(key) ? "changed" : ""}">
        <label title="${esc(s.set)}">${esc(s.label)}</label>
        <input type="number" step="1" data-stat="${s.base_off}" data-orig="${s.value}" value="${val}"></div>`;
    }).join("");
    el.innerHTML = `<p class="muted">Health &amp; stats are editable (sets base &amp; current). Disposition is shown above; note that guild aggro comes from the <b>Crimes</b> tab, not here.</p>
      <div class="grid">${rows || "<div class='empty'>no editable stats</div>"}</div>`;
    el.querySelectorAll("input[data-stat]").forEach(i => i.oninput = onNpcStat);
  } else if (npcSub === "merchant") {
    renderNpcMerchant(d, el);
  } else {
    const note = `<p class="muted">Everything this character holds. Weapons show an <b>equip</b> button (melee/ranged by item type); the wielded one shows the <b>EQUIPPED</b> pill. Add new items with <b>＋ Add item</b>.</p>`;
    const addBtn = `<div class="additem"><button class="npc-add-item primary small">＋ Add item…</button>
      <span class="muted">adds to this character's pack — then click <b>equip</b> on a weapon to wield it</span></div>`;
    // currently-wielded item per weapon slot (pending swap wins over the saved one)
    const eqOf = (slot) => npcEquip.has(`${d.id} ${slot}`)
      ? npcEquip.get(`${d.id} ${slot}`).item
      : (d.inventory.find(x => x.type === slot) || {}).item;
    const eq = { MeleeSlot: eqOf("MeleeSlot"), RangedSlot: eqOf("RangedSlot") };
    const weaponSlot = (item) => item.startsWith("ItMw") ? "MeleeSlot"
      : item.startsWith("ItRw") ? "RangedSlot" : null;
    const equipCell = (item) => {
      const ws = weaponSlot(item);
      if (!ws) return "";
      return eq[ws] === item
        ? `<span class="eq-badge">equipped</span>`
        : `<button type="button" class="link npc-equip" data-equip="${esc(item)}" data-slot="${ws}">equip</button>`;
    };

    // The equipped weapon already appears in Carried, so hide the separate
    // MeleeSlot/RangedSlot rows; the EQUIPPED pill marks it in the list.
    const HIDE = new Set(["MeleeSlot", "RangedSlot"]);
    let items = d.inventory.filter(it => !HIDE.has(it.type));
    for (const slot of ["MeleeSlot", "RangedSlot"]) {   // safety: equipped weapon not in Carried
      const ei = eq[slot];
      if (ei && !items.some(it => it.item === ei)) {
        const e2 = d.inventory.find(x => x.type === slot && x.item === ei);
        if (e2) items = items.concat([{ ...e2, type: "MainContainer", type_label: "Carried" }]);
      }
    }

    const myAdds = npcInvAdds.filter(a => a.npc === d.id);
    const addRow = (a) => `<div class="attr added"><label title="${esc(a.item)}">+ ${esc(a.label)}<small>${esc(a.item)}</small></label>
      ${equipCell(a.item)}
      <input type="number" step="1" min="1" data-nadd="${a.uid}" value="${a.count}">
      <button type="button" class="link rm" data-nrm="${a.uid}" title="remove">✕</button></div>`;
    const row = (it) => {
      const key = `${d.id} ${it.id}`;
      const val = npcInvChanges.has(key) ? npcInvChanges.get(key) : it.count;
      return `<div class="attr ${npcInvChanges.has(key) ? "changed" : ""}">
        <label title="${esc(it.item)}">${esc(it.label)}<small>${esc(it.item)}</small></label>
        ${equipCell(it.item)}
        <input type="number" step="1" min="0" data-inv="${esc(it.id)}" data-orig="${it.count}" value="${val}"></div>`;
    };
    const groups = {};
    items.forEach(it => (groups[it.type_label] ??= []).push(it));
    const ORDER = ["Carried", "Quick slot", "Pouch"];
    const keys = Object.keys(groups).sort((a, b) =>
      (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
    const body = keys.map(g => {
      const adds = g === "Carried" ? myAdds.map(addRow).join("") : "";   // new items fold into Carried
      return `<div class="grp"><h3>${esc(g)}</h3><div class="grid npc-grid">${adds}${groups[g].map(row).join("")}</div></div>`;
    }).join("");
    // if there were adds but no Carried group yet, make one
    const carriedShown = keys.includes("Carried");
    const addsOnly = (!carriedShown && myAdds.length)
      ? `<div class="grp"><h3>Carried</h3><div class="grid npc-grid">${myAdds.map(addRow).join("")}</div></div>` : "";
    el.innerHTML = note + addBtn + addsOnly + (body || (addsOnly ? "" : `<div class="empty">no items</div>`));
    el.querySelectorAll("input[data-inv]").forEach(i => i.oninput = onNpcInv);
    el.querySelector(".npc-add-item").onclick = openNpcAddPicker;
    el.querySelectorAll(".npc-equip").forEach(b => b.onclick = () => onNpcEquip(b.dataset.equip, b.dataset.slot));
    el.querySelectorAll("input[data-nadd]").forEach(i => i.oninput = (e) => {
      const a = npcInvAdds.find(x => x.uid === +e.currentTarget.dataset.nadd);
      if (a) a.count = Math.max(1, Math.floor(+e.currentTarget.value || 1));
    });
    el.querySelectorAll("[data-nrm]").forEach(b => b.onclick = () => {
      const i = npcInvAdds.findIndex(x => x.uid === +b.dataset.nrm);
      if (i >= 0) npcInvAdds.splice(i, 1); renderNpcSub(); updateBar();
    });
  }
}

// equip a weapon FROM the inventory: set its slot (melee/ranged). Picking the
// already-saved weapon clears the pending change.
function onNpcEquip(item, slot) {
  const d = npcCache[npcSel];
  const key = `${npcSel} ${slot}`;
  const actual = (d.inventory.find(x => x.type === slot) || {}).item;
  if (item === actual) npcEquip.delete(key);
  else {
    const known = itemDb.find(it => it.id === item);
    npcEquip.set(key, { item, label: known ? known.label : item });
  }
  renderNpcSub(); updateBar();
}

// -------- merchant (trader sell list = m_Items, separate from the pack) --------
let _npcTradeUid = 0;
function renderNpcMerchant(d, el) {
  const note = `<p class="muted">This trader's <b>sell list</b> — current stock that depletes as you buy. Edit a stock count, or add an item to sell.</p>`;
  const addBtn = `<div class="additem"><button class="npc-trade-add primary small">＋ Add item to sell…</button>
    <span class="muted">adds the item to this trader's stock (and default restock)</span></div>`;
  const myAdds = npcTradeAdds.filter(a => a.npc === d.id);
  const addRow = (a) => `<div class="attr added"><label title="${esc(a.item)}">+ ${esc(a.label)}<small>${esc(a.item)}</small></label>
    <input type="number" step="1" min="1" data-tadd="${a.uid}" value="${a.count}">
    <button type="button" class="link rm" data-trm="${a.uid}" title="remove">✕</button></div>`;
  const row = (it) => {
    const key = `${d.id} ${it.id}`;
    const val = npcTradeChanges.has(key) ? npcTradeChanges.get(key) : it.count;
    return `<div class="attr ${npcTradeChanges.has(key) ? "changed" : ""}">
      <label title="${esc(it.item)}">${esc(it.label)}<small>${esc(it.item)}</small></label>
      <input type="number" step="1" min="0" data-trade="${esc(it.id)}" data-orig="${it.count}" value="${val}"></div>`;
  };
  const rows = (d.trade || []).map(row).join("");
  el.innerHTML = note + addBtn +
    `<div class="grp"><h3>Sell list (${(d.trade || []).length})</h3><div class="grid npc-grid">${myAdds.map(addRow).join("")}${rows || "<div class='empty'>empty</div>"}</div></div>`;
  el.querySelector(".npc-trade-add").onclick = openNpcTradePicker;
  el.querySelectorAll("input[data-trade]").forEach(i => i.oninput = onNpcTrade);
  el.querySelectorAll("input[data-tadd]").forEach(i => i.oninput = (e) => {
    const a = npcTradeAdds.find(x => x.uid === +e.currentTarget.dataset.tadd);
    if (a) a.count = Math.max(1, Math.floor(+e.currentTarget.value || 1));
  });
  el.querySelectorAll("[data-trm]").forEach(b => b.onclick = () => {
    const i = npcTradeAdds.findIndex(x => x.uid === +b.dataset.trm);
    if (i >= 0) npcTradeAdds.splice(i, 1); renderNpcSub(); updateBar();
  });
}

function onNpcTrade(e) {
  const key = `${npcSel} ${e.target.dataset.trade}`, orig = +e.target.dataset.orig, v = e.target.value;
  if (v === "" || +v === orig) npcTradeChanges.delete(key);
  else npcTradeChanges.set(key, Math.max(0, Math.floor(+v)));
  e.target.closest(".attr").classList.toggle("changed", npcTradeChanges.has(key));
  updateBar();
}

function openNpcTradePicker() {
  const npc = npcSel;
  openPicker({
    title: "Add item to sell — " + (npcCache[npc] ? npcCache[npc].name : "trader"),
    placeholder: "Filter items… (name or key)",
    status: "Click an item to add it (qty 1) to this trader's sell list.",
    items: itemDb.map(it => ({ key: it.id, label: it.label, category: it.category, stats: it.stats })),
    badge: (k) => { const n = npcTradeAdds.filter(a => a.npc === npc && a.item === k).length; return n ? `×${n}` : "＋"; },
    onPick: (k) => {
      const known = itemDb.find(it => it.id === k);
      npcTradeAdds.push({ uid: ++_npcTradeUid, npc, item: k, label: known ? known.label : k, count: 1 });
      renderNpcSub(); updateBar();
      const n = npcTradeAdds.filter(a => a.npc === npc && a.item === k).length;
      return `Added ${known ? known.label : k} — ${n} queued (adjust amount in the list)`;
    },
  });
}

let _npcAddUid = 0;
function openNpcAddPicker() {
  const npc = npcSel;
  openPicker({
    title: "Add item to " + (npcCache[npc] ? npcCache[npc].name : "NPC"),
    placeholder: "Filter items… (name or key)",
    status: "Click an item to add it (qty 1) to this character's pack.",
    items: itemDb.map(it => ({ key: it.id, label: it.label, category: it.category, stats: it.stats })),
    badge: (k) => { const n = npcInvAdds.filter(a => a.npc === npc && a.item === k).length; return n ? `×${n}` : "＋"; },
    onPick: (k) => {
      const known = itemDb.find(it => it.id === k);
      npcInvAdds.push({ uid: ++_npcAddUid, npc, item: k, label: known ? known.label : k, count: 1 });
      renderNpcSub(); updateBar();
      const n = npcInvAdds.filter(a => a.npc === npc && a.item === k).length;
      return `Added ${known ? known.label : k} — ${n} queued (adjust amount in the list)`;
    },
  });
}

function onNpcStat(e) {
  const key = `${npcSel} ${e.target.dataset.stat}`, orig = +e.target.dataset.orig, v = e.target.value;
  if (v === "" || +v === orig) npcStatChanges.delete(key);
  else npcStatChanges.set(key, +v);
  e.target.closest(".attr").classList.toggle("changed", npcStatChanges.has(key));
  updateBar();
}

function onNpcLocation(e) {
  const d = npcCache[npcSel], axis = e.target.dataset.location, v = e.target.value;
  const cur = npcLocationChanges.get(d.id) || d.location;
  const next = { x: cur.x, y: cur.y, z: cur.z };
  next[axis] = v === "" ? d.location[axis] : +v;
  if (["x", "y", "z"].every(k => next[k] === d.location[k])) npcLocationChanges.delete(d.id);
  else npcLocationChanges.set(d.id, next);
  e.target.closest(".attr").classList.toggle("changed", npcLocationChanges.has(d.id));
  updateBar();
}

function onNpcInv(e) {
  const key = `${npcSel} ${e.target.dataset.inv}`, orig = +e.target.dataset.orig, v = e.target.value;
  if (v === "" || +v === orig) npcInvChanges.delete(key);
  else npcInvChanges.set(key, Math.max(0, Math.floor(+v)));
  e.target.closest(".attr").classList.toggle("changed", npcInvChanges.has(key));
  updateBar();
}

// split a "npcId slot" map key back into [npcId, slot] (npc ids contain no spaces;
// slot is a numeric base_off for stats, or an "item|type" string for inventory)
const _splitNpcKey = (k) => { const i = k.lastIndexOf(" "); return [k.slice(0, i), k.slice(i + 1)]; };

// ---------------------------------------------------------------- generate
function updateBar() {
  const n = attrChanges.size + questChanges.size + skillChanges.size + invChanges.size
    + invAdds.length + passChanges.size + passAdds.length + crimeForgive.size
    + npcStatChanges.size + npcLocationChanges.size + npcInvAdds.length + npcEquip.size
    + npcTradeChanges.size + npcTradeAdds.length;
  $("#pending").textContent = n === 1 ? "1 change" : `${n} changes`;
  $("#generate").disabled = n === 0;
  $("#clear").disabled = n === 0;
}

$("#clear").onclick = () => {
  attrChanges.clear(); questChanges.clear(); skillChanges.clear(); invChanges.clear();
  invAdds.length = 0; passChanges.clear(); passAdds.length = 0; crimeForgive.clear();
  npcStatChanges.clear(); npcLocationChanges.clear(); npcInvChanges.clear(); npcInvAdds.length = 0; npcEquip.clear(); npcTradeChanges.clear(); npcTradeAdds.length = 0;
  renderAttrs("character"); renderSkills();
  renderInventory(); renderNpcList(); renderNpcDetail(); renderPassages(); renderCrimes(); renderQuests(); updateBar();
};

$("#generate").onclick = async () => {
  const btn = $("#generate");
  btn.disabled = true; btn.textContent = "Recompiling…";
  const doPatch = () => fetch("/api/patch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: session.token, filename: session.filename,
      attr_changes: [...attrChanges].map(([id, value]) => ({ id, value })),
      inv_changes: [...invChanges].map(([id, value]) => ({ id, value })),
      inv_adds: invAdds.map(a => ({ item: a.item, count: a.count })),
      passage_changes: [...passChanges].map(([name, value]) => ({ name, value })),
      passage_adds: passAdds.map(a => ({ name: a.name, value: a.value })),
      crime_forgive: [...crimeForgive].map(k => ({ criminal: k.split("|")[0], guild: k.split("|").slice(1).join("|") })),
      npc_stat_changes: [...npcStatChanges].map(([k, value]) => { const [npc, off] = _splitNpcKey(k); return { npc, base_off: +off, value }; }),
      npc_location_changes: [...npcLocationChanges].map(([npc, v]) => ({ npc, x: v.x, y: v.y, z: v.z })),
      npc_inv_changes: [...npcInvChanges].map(([k, value]) => { const [npc, id] = _splitNpcKey(k); return { npc, id, value }; }),
      npc_inv_adds: npcInvAdds.map(a => ({ npc: a.npc, item: a.item, count: a.count })),
      npc_equip_changes: [...npcEquip].map(([k, v]) => { const [npc, slot_type] = _splitNpcKey(k); return { npc, slot_type, item: v.item }; }),
      npc_trade_changes: [...npcTradeChanges].map(([k, value]) => { const [npc, id] = _splitNpcKey(k); return { npc, id, value }; }),
      npc_trade_adds: npcTradeAdds.map(a => ({ npc: a.npc, item: a.item, count: a.count })),
      skill_changes: [...skillChanges].map(([id, new_tier]) => ({ id, new_tier })),
      quest_changes: [...questChanges].map(([id, new_state]) => ({ id, new_state })),
    }),
  });
  try {
    let r = await doPatch();
    if (r.status === 410) {                 // session expired -> silently recover + retry
      btn.textContent = "Reconnecting…";
      await reauth();
      btn.textContent = "Recompiling…";
      r = await doPatch();
    }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "patch failed"); }
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/);
    download(blob, m ? m[1] : "G1R.fixed.sav");
    toast("✓ Saved. Back up your original, then load the .fixed.sav");
  } catch (e) {
    toast("⚠ " + e.message);
  } finally {
    btn.textContent = "Generate fixed save"; updateBar();
  }
};

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 5000);
}

const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
