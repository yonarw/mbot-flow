"use strict";

// --- block definitions ----------------------------------------------------

const ICONS = {
  up: '<path d="M12 20V5M5 11l7-7 7 7"/>',
  down: '<path d="M12 4v15M5 13l7 7 7-7"/>',
  left: '<path d="M19 20v-6a4 4 0 0 0-4-4H5"/><path d="M9 5l-5 5 5 5"/>',
  right: '<path d="M5 20v-6a4 4 0 0 1 4-4h10"/><path d="M15 5l5 5-5 5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4"/>',
};

// Notes C D E F G A H, then C2 … H2, C3 … H3 and a last C4 (German naming: H = B; English: B). A = 440 Hz is the A
// of the first octave.
const NOTES = (() => {
  const names = ["C", "D", "E", "F", "G", "A", LANG === "de" ? "H" : "B"], semitones = [0, 2, 4, 5, 7, 9, 11], notes = [];
  const add = (name, octave, semi) => notes.push({
    name: name + (octave ? octave + 1 : ""), hz: Math.round(261.6256 * 2 ** ((12 * octave + semi) / 12)),
  });
  for (let octave = 0; octave < 3; octave++) names.forEach((n, i) => add(n, octave, semitones[i]));
  add("C", 3, 0);
  return notes;
})();
// Sharps aren't in the menu (to keep it short) but saved programs may use them, e.g. "Für Elise" (Dis2 = 622 Hz).
// A frequency that is not a note at all still shows up as plain Hz.
const NOTE_NAMES = LANG === "de" ? ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"]   // German: B = A sharp
                                  : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteLabel = hz => {
  const semi = Math.round(12 * Math.log2(hz / 261.6256));
  if (semi < 0 || semi > 36 || Math.round(261.6256 * 2 ** (semi / 12)) !== hz) return `${hz} Hz`;
  const octave = Math.floor(semi / 12);
  return NOTE_NAMES[semi % 12] + (octave ? octave + 1 : "");
};

const STEPS = { key: "n", def: 1, min: 1, max: 20, unit: n => (n === 1 ? tr("Schritt") : tr("Schritte")) };
const ANGLE = { key: "deg", def: 90, options: [45, 90, 135, 180, 270, 360], fmt: o => `${o}°`, aria: tr("Winkel") };
const SECONDS = o => tr("{n} Sek.", { n: fmtNum(o) });
const SHORT_TIMES = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];

const BLOCKS = {
  forward:  { label: tr("Vorwärts"),      cls: "move", icon: "up",    params: [STEPS] },
  backward: { label: tr("Rückwärts"),     cls: "move", icon: "down",  params: [STEPS] },
  left:     { label: tr("Links drehen"),  cls: "turn", icon: "left",  params: [ANGLE] },
  right:    { label: tr("Rechts drehen"), cls: "turn", icon: "right", params: [ANGLE] },
  wait:     { label: tr("Warten"),        cls: "wait", icon: "pause", params: [
    { key: "sec", def: 1, options: [...SHORT_TIMES, 4, 5, 10, 15, 20, 30], fmt: SECONDS, aria: tr("Dauer") },
  ] },
  beep:     { label: tr("Hupen"),         cls: "beep", icon: "bell",  params: [
    { key: "hz", def: 880, options: NOTES.map(n => n.hz), fmt: noteLabel, aria: tr("Ton") },
    { key: "sec", def: 0.25, options: SHORT_TIMES, fmt: SECONDS, aria: tr("Dauer") },
  ] },
  // a saved program used as one block ({ type: "program", name }); the server expands it when it runs
  program:  { label: tr("Programm"),      cls: "sub", palette: false },
};
const STORE_KEY = "mbot-program-v1";
const MODE_KEY = "mbot-mode";
const BLOCKLY_SCRIPTS = ["vendor/blockly/blockly_compressed.js", "vendor/blockly/blocks_compressed.js",
                         `vendor/blockly/msg/${LANG}.js`, "vendor/blockly/continuous-toolbox.js", "advanced.js"];

// --- tiny helpers -----------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];     // constant strings from ICONS only
  return svg;
}

async function api(path, body) {
  const headers = { "X-Lang": LANG };          // the server answers in the page's language
  const res = await fetch(path, body === undefined ? { headers } : {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || tr("Fehler ({status})", { status: res.status }));
  return data;
}

// --- state --------------------------------------------------------------------

let program = [];
let mode = "simple";              // "simple": the list of big blocks; "advanced": Profi, see `view`
let view = "blocks";              // Profi's view of its one program: "blocks" (Blockly, advanced.js) or "flow" (flowchart, flow.js)
const MODE_LABELS = { simple: tr("Einfach"), advanced: tr("Profi") };
const VIEW_KEY = "mbot-view";
const SYNC_KEY = "mbot-view-synced";
let server = { connected: false, running: false, block: null, calibration: null, settings: {} };
let savedPrograms = null;      // [{ name, symbol, blocks, saved }] from the server; null until loaded

// drop unknown blocks and fill in parameters that older saves lack (e.g. the pitch of a beep)
function cleanBlocks(blocks) {
  return blocks.filter(b => BLOCKS[b.type] && (b.type !== "program" || b.name)).map(b => {
    const out = { ...b };
    for (const p of BLOCKS[b.type].params || []) if (out[p.key] == null) out[p.key] = p.def;
    return out;
  });
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (Array.isArray(saved)) program = cleanBlocks(saved);
  } catch (_) { /* no storage: start empty */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(program)); } catch (_) { /* ignore */ }
  scheduleStepCount();      // every edit goes through here
}

function newBlock(type) {
  const def = BLOCKS[type];
  const b = { type };
  for (const p of def.params || []) b[p.key] = p.def;
  return b;
}

// --- banner -----------------------------------------------------------------

let bannerTimer = null;
function showError(msg) {
  const el = $("#banner");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

// --- rendering -----------------------------------------------------------------

function paramControl(p, b, index) {
  const param = h("span", { class: "param" });
  if (p.options) {
    const options = p.options.includes(b[p.key]) ? p.options : [...p.options, b[p.key]].sort((x, y) => x - y);   // keep values of older programs
    param.append(h("select", {
      "aria-label": p.aria,
      onchange: e => { program[index][p.key] = Number(e.target.value); save(); },
    }, options.map(o => h("option", { value: o, selected: o === b[p.key] }, p.fmt(o)))));
    return param;
  }
  const val = h("span", { class: "val" }, fmtNum(b[p.key]));
  const unit = h("span", { class: "unit" }, p.unit(b[p.key]));
  const bump = d => {
    const next = Math.max(p.min, Math.min(p.max, program[index][p.key] + d));
    program[index][p.key] = next;
    val.textContent = fmtNum(next);
    unit.textContent = p.unit(next);
    save();
  };
  param.append(
    h("button", { class: "mini", type: "button", "aria-label": tr("weniger"), onclick: () => bump(-1) }, "−"),
    val,
    h("button", { class: "mini", type: "button", "aria-label": tr("mehr"), onclick: () => bump(1) }, "+"),
    unit,
  );
  return param;
}

function savedProgram(name) {
  return (savedPrograms || []).find(p => p.name.toLowerCase() === String(name).toLowerCase());
}

function blockBody(def, b, index) {
  if (b.type === "program") {
    const p = savedProgram(b.name);
    return [h("span", { class: "sym", "aria-hidden": "true" }, p ? p.symbol : "❓"), h("span", { class: "label" }, b.name),
      p && p.size != null ? h("span", { class: "unit" }, sizeLabel(p.size)) : null];
  }
  return [icon(def.icon), h("span", { class: "label" }, def.label),
    ...(def.params || []).map(p => paramControl(p, b, index))];
}

function renderPalette() {
  const root = $("#palette");
  root.replaceChildren();
  for (const [type, def] of Object.entries(BLOCKS)) {
    if (def.palette === false) continue;
    const el = h("div", {
      class: `block ${def.cls}`, role: "button", tabindex: "0", draggable: "true",
      onclick: () => addBlock(type),
      onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addBlock(type); } },
      ondragstart: e => { e.dataTransfer.setData("text/plain", `new:${type}`); e.dataTransfer.effectAllowed = "copy"; },
    }, icon(def.icon), h("span", { class: "label" }, def.label));
    root.append(el);
  }
}

// Saved programs the one being edited can't use: itself, and every program that uses it (directly or not) –
// using one of them would make it use itself, which never ends.
function blockedPrograms() {
  const blocked = new Set(), own = current.simple.name.toLowerCase();
  if (!own || !savedPrograms) return blocked;
  const queue = [own];
  while (queue.length) {
    const name = queue.shift();
    if (blocked.has(name)) continue;
    blocked.add(name);
    const p = savedProgram(name);
    if (p) queue.push(...p.used_by.map(n => n.toLowerCase()));
  }
  return blocked;
}

function useProgram(name, at) {
  if (blockedPrograms().has(name.toLowerCase())) {
    showError(tr("„{name}“ geht hier nicht: es benutzt „{own}“ – das würde sich selbst aufrufen und nie fertig.", { name, own: current.simple.name }));
    return;
  }
  insertBlock({ type: "program", name }, at);
}

function renderMine() {
  const root = $("#my-programs");
  if (!savedPrograms) return;
  const blocked = blockedPrograms();
  const list = savedPrograms.filter(p => p.kind === "simple").sort((a, b) => a.name.localeCompare(b.name, LANG));
  root.replaceChildren(...(list.length ? list.map(p => blocked.has(p.name.toLowerCase()) ? h("div", {
    class: "block sub blocked", "aria-disabled": "true",
    title: p.name.toLowerCase() === current.simple.name.toLowerCase()
      ? tr("Das ist das Programm, an dem du gerade baust – es kann sich nicht selbst benutzen.")
      : tr("„{name}“ benutzt „{own}“ – hier eingebaut würde es sich selbst aufrufen.", { name: p.name, own: current.simple.name }),
  }, h("span", { class: "sym", "aria-hidden": "true" }, p.symbol), h("span", { class: "label" }, p.name),
    h("span", { class: "unit" }, "🚫")) : h("div", {
    class: "block sub", role: "button", tabindex: "0", draggable: "true",
    title: blockCount(p.blocks),
    onclick: () => useProgram(p.name),
    onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); useProgram(p.name); } },
    ondragstart: e => { e.dataTransfer.setData("text/plain", `prog:${p.name}`); e.dataTransfer.effectAllowed = "copy"; },
  }, h("span", { class: "sym", "aria-hidden": "true" }, p.symbol), h("span", { class: "label" }, p.name),
    p.size != null ? h("span", { class: "unit" }, sizeLabel(p.size)) : null))
    : [h("p", { class: "mine-empty" }, tr("Noch nichts gespeichert. Speichere ein Programm mit 💾 – dann taucht es hier auf."))]));
}

async function refreshMine() {
  try {
    savedPrograms = (await api("/api/programs")).programs;
    renderMine();
    renderProgram();          // symbols of program blocks, or "missing" marks
    scheduleStepCount();      // a saved program the editor uses may have changed
  } catch (_) { /* server unreachable: the status chip says so */ }
}

function renderProgram() {
  const list = $("#program");
  list.replaceChildren();
  program.forEach((b, i) => {
    const def = BLOCKS[b.type];
    const missing = b.type === "program" && savedPrograms && !savedProgram(b.name);
    const li = h("li", {
      class: `block ${def.cls}` + (missing ? " missing" : "") + (stepCount.errorBlock === String(i) ? " error" : "")
        + (server.running && server.top_block === String(i) ? " active" : ""),
      title: missing ? tr("Dieses Programm gibt es nicht mehr.") : stepCount.errorBlock === String(i) ? stepCount.error : null,
      draggable: "true", "data-index": i,
      ondragstart: e => {
        e.dataTransfer.setData("text/plain", `move:${i}`);
        e.dataTransfer.effectAllowed = "move";
        requestAnimationFrame(() => li.classList.add("dragging"));
      },
      ondragend: () => { li.classList.remove("dragging"); clearDropMarks(); },
    },
    blockBody(def, b, i),
    h("span", { class: "tools" },
      h("button", { class: "mini", type: "button", "aria-label": tr("nach oben"), disabled: i === 0, onclick: () => moveBlock(i, i - 1) }, "▲"),
      h("button", { class: "mini", type: "button", "aria-label": tr("nach unten"), disabled: i === program.length - 1, onclick: () => moveBlock(i, i + 1) }, "▼"),
      h("button", { class: "mini", type: "button", "aria-label": tr("löschen"), onclick: () => removeBlock(i) }, "✕")));
    list.append(li);
  });
}

function updateActive() {
  document.querySelectorAll("#program .block").forEach((el, i) => {
    el.classList.toggle("active", server.running && server.top_block === String(i));
  });
}

// Progress of the running block, as last reported by the server; carried forward between polls so it fills smoothly.
let progress = null;                     // { block, done, total, at } (ms, at = performance.now())
let shown = { block: null, p: 0 };       // what is on screen: never jump backwards within a block

function drawProgress() {
  if (progress || shown.block !== null) {
    const p = progress ? Math.min(1, (progress.done + performance.now() - progress.at) / progress.total) : 0;
    shown = progress ? { block: progress.block, p: progress.block === shown.block ? Math.max(p, shown.p) : p }
                     : { block: null, p: 0 };
    document.querySelectorAll("#program .block").forEach((el, i) => {
      if (String(i) === shown.block) el.style.setProperty("--p", `${(shown.p * 100).toFixed(1)}%`);
      else el.style.removeProperty("--p");
    });
  }
  requestAnimationFrame(drawProgress);
}

// --- editing ---------------------------------------------------------------------

function addBlock(type, at = program.length) { insertBlock(newBlock(type), at); }
function insertBlock(block, at = program.length) {
  program.splice(at, 0, block);
  save(); renderProgram();
}
function removeBlock(i) { program.splice(i, 1); save(); renderProgram(); }
function moveBlock(from, to) {
  if (to < 0 || to >= program.length) return;
  program.splice(to, 0, program.splice(from, 1)[0]);
  save(); renderProgram();
}

// --- drag and drop onto the program list --------------------------------------------

function dropIndex(clientY) {
  const items = [...document.querySelectorAll("#program .block:not(.dragging)")];
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { index: Number(el.dataset.index), el, before: true };
  }
  const last = items[items.length - 1];
  return { index: program.length, el: last || null, before: false };
}
function clearDropMarks() {
  document.querySelectorAll(".drop-before,.drop-after").forEach(el => el.classList.remove("drop-before", "drop-after"));
  $(".program").classList.remove("drag-over");
}

function setupDrop() {
  const zone = $(".program");
  zone.addEventListener("dragover", e => {
    e.preventDefault();
    clearDropMarks();
    zone.classList.add("drag-over");
    const d = dropIndex(e.clientY);
    if (d.el) d.el.classList.add(d.before ? "drop-before" : "drop-after");
  });
  zone.addEventListener("dragleave", e => { if (!zone.contains(e.relatedTarget)) clearDropMarks(); });
  zone.addEventListener("drop", e => {
    e.preventDefault();
    const d = dropIndex(e.clientY);
    clearDropMarks();
    const data = e.dataTransfer.getData("text/plain") || "";
    const kind = data.slice(0, data.indexOf(":")), val = data.slice(data.indexOf(":") + 1);   // names may contain ":"
    if (kind === "new" && BLOCKS[val] && BLOCKS[val].palette !== false) addBlock(val, d.index);
    else if (kind === "prog" && val) useProgram(val, d.index);
    else if (kind === "move") {
      const from = Number(val);
      if (Number.isInteger(from) && from >= 0 && from < program.length) {
        program.splice(from < d.index ? d.index - 1 : d.index, 0, program.splice(from, 1)[0]);
        save(); renderProgram();
      }
    }
  });
}

// --- running ------------------------------------------------------------------------

function requireConnection() {
  if (server.connected) return true;
  if (server.auto && server.auto.state === "trying") { showError(tr("Einen Moment – ich verbinde gerade mit dem Roboter.")); return false; }
  showError(tr("Der Roboter ist noch nicht verbunden."));
  openConnect();
  return false;
}

async function run() {
  let body;
  if (mode === "advanced") {
    if (!profi()) return;
    try { body = { ast: profi().toAst() }; } catch (e) { showError(e.message); return; }
  } else {
    if (!program.length) { showError(tr("Zieh zuerst ein paar Bausteine ins Programm.")); return; }
    body = { blocks: program };
  }
  if (!requireConnection()) return;
  try { await api("/api/run", body); } catch (e) { showError(e.message); }
}
async function stop() {
  try { await api("/api/stop", {}); } catch (e) { showError(e.message); }
}

function linkLabel(link) {
  if (link.endsWith("sim/tty")) return tr("Simulator");
  return link.split("/").pop();          // /dev/ttyUSB0 -> ttyUSB0, a BLE address stays as it is
}

// --- robot state: server-sent events while connected, plus a slow poll for the rest -----------------

function applyState(s) {
  const wasRunning = server.running;
  server = { ...server, ...s };
  if (s.max_size && s.max_size !== maxSize) { maxSize = s.max_size; renderMeter(); }
  progress = s.running && s.top_block != null && s.block_ms > 0
    ? { block: s.top_block, done: s.block_done_ms, total: s.block_ms, at: performance.now() } : null;
  const chip = $("#status"), auto = s.auto;
  chip.className = "chip " + (s.connected ? "on" : "off");
  chip.textContent = s.connected ? tr("● Verbunden ({link})", { link: linkLabel(s.link) })
    : auto && auto.state === "trying" ? tr("◌ Verbinde … (Versuch {n} von {tries})", { n: auto.attempt, tries: auto.tries })
    : tr("○ Nicht verbunden");
  // the server tried the last connection at startup and gave up: ask, once per failed round
  const failed = !s.connected && auto && auto.state === "failed";
  if (failed && !autoDialogShown) {
    autoDialogShown = true;
    openConnect();
    setMsg($("#dlg-connect-msg"), tr("Automatisch verbinden ({link}) hat {tries}× nicht geklappt: {error}", { link: linkLabel(auto.target), tries: auto.tries, error: auto.error }), "err");
  }
  if (!failed) autoDialogShown = false;
  document.querySelectorAll('[data-action="run"]').forEach(b => { b.disabled = s.running; });
  document.querySelectorAll('[data-action="stop"]').forEach(b => { b.disabled = !s.running; });
  if ((s.error || null) !== shownError) { shownError = s.error || null; if (s.error) showError(s.error); }   // each message once
  if (wasRunning !== s.running || s.running) updateActive();
  if (window.Advanced && Advanced.ready()) Advanced.highlight(s.running ? s.block : null);
  if (Flow.ready()) Flow.highlight(s.running ? s.block : null, s.running ? s.top_block : null);
  renderLive(s);
}
let shownError = null;
let autoDialogShown = false;

async function poll() {
  try {
    applyState(await api("/api/state"));
  } catch (_) {
    $("#status").className = "chip off";
    $("#status").textContent = tr("○ Server nicht erreichbar");
  }
}

function listen() {
  const events = new EventSource(`/api/events?lang=${LANG}`);     // reconnects by itself
  events.onmessage = e => { try { applyState(JSON.parse(e.data)); } catch (_) { /* ignore */ } };
}

// --- what the robot sees -----------------------------------------------------------------------

let varNames = "";
function renderLive(s) {
  const sn = s.sensors;
  $(".live").classList.toggle("stale", !sn);
  if (!sn) return;
  $("#s-line-left").classList.toggle("black", sn.line_left);
  $("#s-line-right").classList.toggle("black", sn.line_right);
  $("#s-distance").textContent = sn.distance >= 400 ? tr("frei") : `${sn.distance} cm`;
  $("#s-light").textContent = sn.light;
  $("#s-button").textContent = sn.button ? tr("gedrückt") : "–";
  $("#s-motors").textContent = sn.motor_left || sn.motor_right ? `${sn.motor_left} % · ${sn.motor_right} %` : tr("aus");
  $("#s-timer").textContent = s.running ? `${fmtNum((sn.timer / 1000).toFixed(1))} s` : "–";
  const vars = s.vars || [], box = $("#vars"), names = vars.map(v => v.name).join("\n");
  box.hidden = !vars.length;
  if (names !== varNames) {
    varNames = names;
    box.replaceChildren(...vars.map(v => h("div", {}, h("dt", {}, v.name), h("dd", {}))));
  }
  vars.forEach((v, i) => { box.children[i].lastChild.textContent = v.value; });
}

// --- connection dialog ------------------------------------------------------------------

function setMsg(el, text, kind = "") { el.textContent = text; el.className = "msg " + kind; }

async function refreshPorts() {
  const sel = $("#port-select");
  try {
    const { ports } = await api("/api/ports");
    sel.replaceChildren(...(ports.length
      ? ports.map(p => h("option", { value: p.path }, p.label))
      : [h("option", { value: "" }, tr("– kein Anschluss gefunden –"))]));
    if (server.settings && server.settings.kind === "serial") sel.value = server.settings.target;
  } catch (e) { setMsg($("#dlg-connect-msg"), e.message, "err"); }
}

function openConnect() {
  const dlg = $("#dlg-connect");
  setMsg($("#dlg-connect-msg"), "");
  if (server.settings && server.settings.kind === "ble") $("#ble-address").value = server.settings.target;
  if (server.settings && server.settings.kind === "wifi") $("#wifi-address").value = server.settings.target;
  refreshPorts();
  if (!dlg.open) dlg.showModal();
}

async function connect(kind, target) {
  const msg = $("#dlg-connect-msg");
  if (!target) { setMsg(msg, tr("Bitte erst etwas auswählen."), "err"); return; }
  setMsg(msg, tr("Verbinde …"));
  try {
    await api("/api/connect", { kind, target });
    setMsg(msg, tr("Verbunden!"), "ok");
    await poll();
    setTimeout(() => $("#dlg-connect").close(), 600);
  } catch (e) { setMsg(msg, e.message, "err"); }
}

async function scanBle() {
  const msg = $("#dlg-connect-msg"), btn = $("#ble-scan");
  btn.disabled = true;
  setMsg(msg, tr("Suche Bluetooth-Geräte …"));
  try {
    const { devices } = await api("/api/scan");
    const likely = d => /makeblock|mbot/i.test(d.name);
    devices.sort((a, b) => likely(b) - likely(a));
    $("#ble-select").replaceChildren(...(devices.length
      ? devices.map(d => h("option", { value: d.address }, `${d.name || tr("(ohne Namen)")} – ${d.address}`))
      : [h("option", { value: "" }, tr("– nichts gefunden –"))]));
    setMsg(msg, devices.length ? tr("{n} Gerät(e) gefunden.", { n: devices.length }) : tr("Nichts gefunden. Ist der Roboter an?"), devices.length ? "ok" : "err");
  } catch (e) { setMsg(msg, e.message, "err"); }
  btn.disabled = false;
}

async function scanWifi() {
  const msg = $("#dlg-connect-msg"), btn = $("#wifi-scan");
  btn.disabled = true;
  setMsg(msg, tr("Suche im WLAN …"));
  try {
    const { devices } = await api("/api/scan-wifi");
    $("#wifi-select").replaceChildren(...(devices.length
      ? devices.map(d => h("option", { value: d.address }, `${d.name} – ${d.address}`))
      : [h("option", { value: "" }, tr("– nichts gefunden –"))]));
    if (devices.length) $("#wifi-address").value = devices[0].address;
    setMsg(msg, devices.length ? tr("Gefunden!") : tr("Nichts gefunden. Ist der Roboter an und blinkt die Pico-LED langsam?"), devices.length ? "ok" : "err");
  } catch (e) { setMsg(msg, e.message, "err"); }
  btn.disabled = false;
}

// --- saving and loading programs -------------------------------------------------------------

const SYMBOLS = ["⭐", "🚗", "🚀", "🐢", "🐇", "🔷", "🔺", "🔁", "🌀", "🏠", "🎵", "🎉", "🐱", "🐶", "🤖", "🌈", "⚽", "🍕"];
const current = { simple: { name: "", symbol: SYMBOLS[0] }, advanced: { name: "", symbol: SYMBOLS[0] } };   // last saved/loaded per mode

function renderSymbols(selected) {
  $("#symbol-picker").replaceChildren(...SYMBOLS.map(s => h("label", {},
    h("input", { type: "radio", name: "symbol", value: s, checked: s === selected, "aria-label": s }),
    h("span", { "aria-hidden": "true" }, s))));
}

function chosenSymbol() {
  const picked = document.querySelector('#symbol-picker input:checked');
  return picked ? picked.value : SYMBOLS[0];
}

let renaming = null;      // name of the saved program the save dialog renames, or null when it saves the editor's program

function openSave() {
  if (mode === "simple" && !program.length) { showError(tr("Zieh zuerst ein paar Bausteine ins Programm.")); return; }
  if (mode === "advanced" && !profi()) return;
  openNameDialog(tr("Programm speichern"), tr("Speichern"), current[mode].name, current[mode].symbol, null);
}

function openRename(p) {
  openNameDialog(tr("Umbenennen"), tr("Übernehmen"), p.name, p.symbol, p.name);
}

function openNameDialog(title, button, name, symbol, renameFrom) {
  renaming = renameFrom;
  $("#dlg-save-title").textContent = title;
  $("#save-confirm").textContent = button;
  $("#save-name").value = name;
  renderSymbols(SYMBOLS.includes(symbol) ? symbol : SYMBOLS[0]);
  setMsg($("#dlg-save-msg"), "");
  $("#dlg-save").showModal();
  $("#save-name").focus();
}

async function confirmSave() {
  const msg = $("#dlg-save-msg"), name = $("#save-name").value.trim().replace(/\s+/g, " "), symbol = chosenSymbol();
  if (!name) { setMsg(msg, tr("Bitte gib dem Programm einen Namen."), "err"); $("#save-name").focus(); return; }
  try {
    if (renaming) {
      const res = await api("/api/programs/rename", { name: renaming, new_name: name, symbol });
      const same = n => n.toLowerCase() === res.old.toLowerCase();
      program.forEach(b => { if (b.type === "program" && same(b.name)) b.name = res.name; });   // the editor follows too
      for (const m of Object.keys(current)) if (same(current[m].name)) current[m] = { ...current[m], name: res.name, symbol: res.symbol };
      save();
    } else {
      const { programs } = await api("/api/programs");
      const clash = programs.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (clash && !confirm(tr("„{name}“ gibt es schon. Überschreiben?", { name: clash.name }))) return;
      // Profi: the document of the view it is shown in (Blockly's or the flowchart's); it opens in either view
      const body = mode === "advanced" ? { name, symbol, workspace: profi().state(), ast: profi().draftAst() }
                                       : { name, symbol, blocks: program };
      const res = await api("/api/programs/save", body);
      current[mode] = { name: res.name, symbol: res.symbol, savedKey: programKey(mode) };
    }
    $("#dlg-save").close();
    refreshMine();
    if ($("#dlg-load").open) refreshSaved();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

async function openLoad() {
  setMsg($("#dlg-load-msg"), "");
  $("#dlg-load").showModal();
  await refreshSaved();
}

const sizeLabel = n => tr("{n} % Platz", { n: Math.max(1, Math.round((n / maxSize) * 100)) });
const blockCount = n => (n === 1 ? tr("1 Baustein") : tr("{n} Bausteine", { n }));

async function refreshSaved() {
  const list = $("#saved-list"), msg = $("#dlg-load-msg");
  try {
    const { programs } = await api("/api/programs");
    programs.sort((a, b) => a.name.localeCompare(b.name, LANG));
    list.replaceChildren(...(programs.length
      ? programs.map(p => {
        const details = [MODE_LABELS[p.kind] || MODE_LABELS.simple, blockCount(p.blocks),
          p.size == null ? tr("kann so nicht laufen") : sizeLabel(p.size)];
        if (p.used_by.length) details.push(tr("benutzt in: {names}", { names: p.used_by.join(", ") }));
        return h("li", {},
          h("span", { class: "sym", "aria-hidden": "true" }, p.symbol),
          h("span", { class: "info" }, h("b", {}, p.name), h("small", {}, details.join(" · "))),
          h("span", { class: "row-actions" },
            h("button", { class: "btn small go", type: "button", onclick: () => loadProgram(p.name) }, tr("Laden")),
            h("button", { class: "mini", type: "button", title: tr("Umbenennen / Symbol ändern"), "aria-label": tr("„{name}“ umbenennen", { name: p.name }), onclick: () => openRename(p) }, "✎"),
            h("button", { class: "mini", type: "button", title: tr("Kopie anlegen"), "aria-label": tr("„{name}“ kopieren", { name: p.name }), onclick: () => duplicateProgram(p.name) }, "⧉"),
            h("button", {
              class: "mini del", type: "button", disabled: p.used_by.length > 0,
              title: p.used_by.length ? tr("Wird in „{name}“ benutzt – nimm es dort zuerst heraus.", { name: p.used_by[0] }) : tr("Löschen"),
              "aria-label": tr("„{name}“ löschen", { name: p.name }), onclick: () => deleteProgram(p.name),
            }, "✕")));
      })
      : [h("li", { class: "saved-empty" }, tr("Noch nichts gespeichert."))]));
  } catch (e) { setMsg(msg, e.message, "err"); }
}

async function loadProgram(name) {
  const msg = $("#dlg-load-msg");
  try {
    const saved = await api("/api/programs/load", { name });
    const kind = saved.kind === "advanced" ? "advanced" : "simple";
    if (!unsavedOk(kind, tr("Dein Programm ist nicht gespeichert und wird ersetzt. Trotzdem laden?"))) return;
    if (kind === "advanced") {
      await setMode("advanced");
      await loadProfi(saved.workspace);
    } else {
      await setMode("simple");
      program = cleanBlocks(saved.blocks);
    }
    current[kind] = { name: saved.name, symbol: saved.symbol, savedKey: programKey(kind) };
    if (kind === "simple") { save(); renderProgram(); renderMine(); }
    $("#dlg-load").close();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

async function duplicateProgram(name) {
  try {
    const res = await api("/api/programs/duplicate", { name });
    setMsg($("#dlg-load-msg"), tr("Kopie „{name}“ angelegt.", { name: res.name }), "ok");
  } catch (e) { setMsg($("#dlg-load-msg"), e.message, "err"); }
  refreshSaved();
  refreshMine();
}

async function deleteProgram(name) {
  if (!confirm(tr("„{name}“ wirklich löschen?", { name }))) return;
  try {
    await api("/api/programs/delete", { name });
    for (const m of Object.keys(current)) if (current[m].name.toLowerCase() === name.toLowerCase()) current[m] = { name: "", symbol: SYMBOLS[0] };
    setMsg($("#dlg-load-msg"), "");
  } catch (e) { setMsg($("#dlg-load-msg"), e.message, "err"); }
  refreshSaved();
  refreshMine();
}

// Asking before a program is replaced ("Neu", "Leeren", "Laden") – only when it has changes that aren't saved.
// programKey: the program as it is now (null: unknown), compared with the one last saved or loaded.
function programKey(m) {
  if (m === "simple") return JSON.stringify(program);
  return profi() ? canonical(profi().exportAst().ast) : null;
}
function programEmpty(m) {
  if (m === "simple") return !program.length;
  if (!profi()) return false;
  const { ast } = profi().exportAst();
  return !ast.body.length && !Object.keys(ast.functions).length;
}
function unsavedOk(m, question) {
  const key = programKey(m);
  return programEmpty(m) || (key !== null && key === current[m].savedKey) || confirm(question);
}

// --- how much of the robot's memory the program uses --------------------------------------------

let maxSize = 768;                         // the robot's program memory in bytes; the server reports the real value
let stepCount = { size: 0, error: null, errorBlock: null };
let stepTimer = null, stepSeq = 0;

function scheduleStepCount() {
  clearTimeout(stepTimer);
  stepTimer = setTimeout(countSteps, 150);
}

// compiles the current mode's program on the server: its size, or why it can't run
async function countSteps() {
  const seq = ++stepSeq;
  let next = { size: 0, error: null, errorBlock: null }, body = null;
  if (mode === "advanced") {
    if (!profi()) return;
    try { body = { ast: profi().toAst() }; } catch (e) { next = { size: null, error: e.message, errorBlock: null }; }
  } else if (program.length) {
    body = { blocks: program, name: current.simple.name || null };   // its own name: it can't use itself
  }
  if (body) {
    try {
      const r = await api("/api/compile", body);
      next = { size: r.size, error: r.error, errorBlock: r.error_block };
      maxSize = r.max_size;
    } catch (_) { return; }
  }
  if (seq !== stepSeq) return;             // the program changed again meanwhile; a newer count is coming
  const blockChanged = next.errorBlock !== stepCount.errorBlock || next.error !== stepCount.error;
  stepCount = next;
  renderMeter();
  if (blockChanged) {                      // mark the block the problem is about
    if (mode === "advanced") profi().markError(next.errorBlock, next.error);
    else renderProgram();
  }
}

function renderMeter() {
  const { size, error } = stepCount, meter = $(mode === "advanced" ? "#adv-meter" : "#step-meter");
  const over = size != null && size > maxSize;
  meter.classList.toggle("over", over || size == null);
  meter.style.setProperty("--fill", `${size == null ? 0 : Math.min(100, (size / maxSize) * 100)}%`);
  $(".meter-text", meter).textContent = size == null ? `⚠ ${error}`
    : over ? tr("Zu groß: {size} von {max} Bytes – das passt nicht in den Roboter!", { size, max: maxSize })
    : tr("{p} % vom Roboter-Speicher belegt ({size} von {max} Bytes)", { p: Math.round((size / maxSize) * 100), size, max: maxSize });
}

// --- simple / advanced mode, and advanced mode's two views ------------------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(tr("{file} fehlt", { file: src })));
    document.head.append(el);
  });
}

let advancedLoading = null;
function ensureAdvanced() {
  if (!advancedLoading) {
    advancedLoading = (async () => {
      for (const src of BLOCKLY_SCRIPTS) await loadScript(src);    // in order: each needs the one before
      $("#blockly").replaceChildren();
      Advanced.init($("#blockly"));
      Advanced.onChange(scheduleStepCount);
    })();
    advancedLoading.catch(e => { advancedLoading = null; showError(tr("Profi-Modus lässt sich nicht laden: {error}", { error: e.message })); });
  }
  return advancedLoading;
}

async function setMode(next) {
  mode = MODE_LABELS[next] ? next : "simple";
  try { localStorage.setItem(MODE_KEY, mode); } catch (_) { /* ignore */ }
  document.body.classList.toggle("mode-advanced", mode === "advanced");
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  if (mode === "advanced") await showView();
  scheduleStepCount();
}

// The editor of the Profi view shown, once it is ready (null while Blockly is still loading).
function profi() {
  if (view === "flow") return Flow.ready() ? Flow : null;
  return window.Advanced && Advanced.ready() ? Advanced : null;
}

async function profiEditor(v) {
  if (v === "flow") {
    if (!Flow.ready()) { Flow.init($("#flow")); Flow.onChange(scheduleStepCount); }
    return Flow;
  }
  await ensureAdvanced();
  return Advanced;
}

async function showView() {
  document.body.classList.toggle("view-flow", view === "flow");
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  const editor = await profiEditor(view);
  if (view === "flow") Flow.show(); else Advanced.resize();
  editor.highlight(server.running ? server.block : null, server.running ? server.top_block : null);
}

// Both views show the same program: switching converts it (through the compiler's syntax tree). SYNC_KEY
// remembers the program both views held after the last conversion, so going back and forth without changing
// anything keeps each view as it was (Blockly's block positions, loose stacks).
const canonical = ast => JSON.stringify(ast, (key, value) => {
  if (key === "else" && Array.isArray(value) && !value.length) return undefined;     // an empty "nein" lane is no "sonst"
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return value;
});
function synced() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || "[]"); } catch (_) { return []; }
}
function setSynced(keys) {
  try { if (keys) localStorage.setItem(SYNC_KEY, JSON.stringify(keys)); else localStorage.removeItem(SYNC_KEY); } catch (_) { /* ignore */ }
}

async function convert(from, to) {
  const src = await profiEditor(from), dst = await profiEditor(to);
  const out = src.exportAst();
  if (out.loose) {          // also when nothing is converted now: the next change in the flowchart replaces them
    showError(out.loose === 1
      ? tr("Ein Stapel liegt lose herum (nicht unter „Wenn ▶ Start geklickt“). Im Ablauf gibt es dafür keinen Platz – änderst du dort etwas, ist er weg.")
      : tr("{n} Stapel liegen lose herum (nicht unter „Wenn ▶ Start geklickt“). Im Ablauf gibt es dafür keinen Platz – änderst du dort etwas, sind sie weg.",
           { n: out.loose }));
  }
  const key = canonical(out.ast);
  if (synced().includes(key)) return;
  dst.loadAst(out.ast, out.vars);
  setSynced([key, canonical(dst.exportAst().ast)]);
}

let viewBusy = false;
async function setView(next) {
  if (next === view || viewBusy || !profi()) return;
  viewBusy = true;
  try {
    const from = view;
    view = next;
    try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* ignore */ }
    document.body.classList.toggle("view-flow", view === "flow");    // visible before it is filled: Blockly measures
    await convert(from, view);
    await showView();
    stepCount = { size: 0, error: null, errorBlock: null };          // mark the error again, in this view
    scheduleStepCount();
  } catch (e) {
    showError(tr("Umschalten hat nicht geklappt: {error}", { error: e.message }));
  } finally {
    viewBusy = false;
  }
}

// a saved Profi program: into the view it was saved in, then shown in the current one
async function loadProfi(doc) {
  const native = doc && Array.isArray(doc.main) ? "flow" : "blocks";
  (await profiEditor(native)).load(doc);
  setSynced(null);
  if (native !== view) await convert(native, view);
  await showView();
}

// --- calibration dialog ---------------------------------------------------------------------

const CAL_FIELDS = {
  speed: v => `${v} %`, turn_speed: v => `${v} %`, forward_ms: v => `${v} ms`, trim: v => (v > 0 ? `+${v}` : `${v}`),
  turn_left_ms: v => `${v} ms`, turn_right_ms: v => `${v} ms`, settle_ms: v => `${v} ms`,
};

function calForm() { return $("#cal-form"); }

function readCal() {
  const f = calForm().elements, cal = {};
  for (const name of [...Object.keys(CAL_FIELDS), "step_cm"]) cal[name] = Number(f[name].value);
  cal.reverse = f.reverse.checked;
  return cal;
}
function writeCal(cal) {
  const f = calForm().elements;
  for (const name of [...Object.keys(CAL_FIELDS), "step_cm"]) f[name].value = cal[name];
  f.reverse.checked = !!cal.reverse;
  refreshOutputs();
}
function refreshOutputs() {
  const f = calForm().elements;
  for (const [name, fmt] of Object.entries(CAL_FIELDS)) {
    const out = f[name].parentElement.querySelector("output");
    if (out) out.textContent = fmt(Number(f[name].value));
  }
}

async function openCal() {
  await poll();
  writeCal(server.calibration);
  setMsg($("#dlg-cal-msg"), "");
  $("#dlg-cal").showModal();
}

const TESTS = {
  forward: [{ type: "forward", n: 1 }],
  straight: [{ type: "forward", n: 3 }],
  left: [{ type: "left", deg: 90 }],
  right: [{ type: "right", deg: 90 }],
};

async function calTest(name) {
  const msg = $("#dlg-cal-msg");
  if (!server.connected) { setMsg(msg, tr("Der Roboter ist nicht verbunden."), "err"); return; }
  try {
    await api("/api/run", { blocks: TESTS[name], cal: readCal() });
    setMsg(msg, tr("Läuft … schau, was der Roboter macht."));
  } catch (e) { setMsg(msg, e.message, "err"); }
}

// measured result -> new duration (proportional: twice as far needs twice as long)
function calFit(which) {
  const f = calForm().elements, msg = $("#dlg-cal-msg");
  const pick = {
    dist: { field: "forward_ms", input: "#meas-dist", target: Number(f.step_cm.value) },
    left: { field: "turn_left_ms", input: "#meas-left", target: 90 },
    right: { field: "turn_right_ms", input: "#meas-right", target: 90 },
  }[which];
  const measured = Number($(pick.input).value);
  if (!(measured > 0)) { setMsg(msg, tr("Trag zuerst den gemessenen Wert ein."), "err"); return; }
  const input = f[pick.field];
  const next = Math.round(Number(input.value) * pick.target / measured);
  input.value = Math.max(Number(input.min), Math.min(Number(input.max), next));
  $(pick.input).value = "";
  refreshOutputs();
  setMsg(msg, tr("Angepasst. Teste noch einmal."), "ok");
}

async function calSave() {
  const msg = $("#dlg-cal-msg");
  try {
    await api("/api/calibration", readCal());
    setMsg(msg, tr("Gespeichert!"), "ok");
    await poll();
  } catch (e) { setMsg(msg, e.message, "err"); }
}

// --- remote control: arrow keys drive, space honks ----------------------------------------------

const REMOTE_KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", " ": "horn" };
const REMOTE_REPEAT_MS = 150;     // the robot stops by itself 500 ms after the last command (deadman), so one late
                                  // repeat doesn't make it stop, and a dead browser/server/link stops it quickly
const HORN_NOTES = NOTES.slice(0, 15);   // C … C3: the higher notes are shrill on the little buzzer
const STICK_DEADZONE = 0.15;      // worn sticks don't rest exactly at 0
const held = new Set();
let stick = { fwd: 0, turn: 0 };   // controller left stick, -1..1
let stickLocked = false;           // after an error: ignore the stick until it is let go, instead of repeating the error
let padHorn = false;
let hornHz = null, remoteBusy = false, remoteDirty = false, remoteTimer = null;

const keysHeld = () => ["up", "down", "left", "right"].some(k => held.has(k));
const stickActive = () => stick.fwd !== 0 || stick.turn !== 0;

function updatePad() {
  const lit = { up: stick.fwd > 0, down: stick.fwd < 0, left: stick.turn < 0, right: stick.turn > 0 };
  document.querySelectorAll("[data-remote]").forEach(el => {
    const key = el.dataset.remote;
    if (key !== "horn") el.classList.toggle("pressed", held.has(key) || lit[key]);
  });
}

// One request at a time, always with the latest input, so a late "drive" can never overtake a "stop".
// Arrow keys win over the controller while any of them is held.
async function remoteSend() {
  if (remoteBusy) { remoteDirty = true; return; }
  remoteBusy = true;
  clearTimeout(remoteTimer);
  const keys = keysHeld();
  const fwd = keys ? held.has("up") - held.has("down") : stick.fwd;
  const turn = keys ? held.has("right") - held.has("left") : stick.turn;
  const horn = hornHz;
  hornHz = null;
  try { await api("/api/remote", { fwd, turn, horn, analog: !keys }); }
  catch (e) {
    showError(e.message);
    held.clear();
    stickLocked = stickActive();
    stick = { fwd: 0, turn: 0 };
    updatePad();
  }
  remoteBusy = false;
  if (remoteDirty) { remoteDirty = false; remoteSend(); }
  else if (keysHeld() || stickActive()) remoteTimer = setTimeout(remoteSend, REMOTE_REPEAT_MS);
}

// deadzone removed and rescaled to 0..1, in steps of 0.1 so a resting thumb doesn't send a request every frame
function stickAxis(v) {
  const a = Math.abs(v || 0);
  return a < STICK_DEADZONE ? 0 : Math.sign(v) * Math.round((a - STICK_DEADZONE) / (1 - STICK_DEADZONE) * 10) / 10;
}

function pollGamepad() {
  let pads = [];
  try { pads = [...navigator.getGamepads()].filter(p => p && p.connected); } catch (_) { /* not allowed here */ }
  const hint = pads.length
    ? tr("🎮 {pad}: linker Stick fahren und lenken, A = Hupe.", { pad: pads[0].id.split("(")[0].trim() || "Controller" })
    : tr("🎮 Controller anstecken und eine Taste drücken, dann: linker Stick fahren und lenken.");
  if ($("#pad-hint").textContent !== hint) $("#pad-hint").textContent = hint;
  // only while this page has the focus and no dialog is open, like the keys
  const pad = document.hasFocus() && !document.querySelector("dialog[open]") ? pads[0] : null;
  // left stick only: Firefox on Linux reports the Xbox pad's right stick as buttons, not as axes
  let next = pad ? { fwd: stickAxis(-pad.axes[1]), turn: stickAxis(pad.axes[0]) } : { fwd: 0, turn: 0 };
  if (stickLocked) {
    if (!next.fwd && !next.turn) stickLocked = false;
    next = { fwd: 0, turn: 0 };
  }
  if (next.fwd !== stick.fwd || next.turn !== stick.turn) {
    stick = next;
    updatePad();
    if (stickActive() && !server.connected) {
      stickLocked = true;
      stick = { fwd: 0, turn: 0 };
      updatePad();
      showError(tr("Der Roboter ist noch nicht verbunden."));
    } else {
      remoteSend();
    }
  }
  const a = !!(pad && pad.buttons[0] && pad.buttons[0].pressed);   // A on Xbox layouts, ✕ on PlayStation
  if (a && !padHorn) remotePress("horn");
  padHorn = a;
}

function remotePress(key) {
  if (!requireConnection()) return;
  if (key === "horn") {
    hornHz = HORN_NOTES[Math.floor(Math.random() * HORN_NOTES.length)].hz;
    const btn = $('[data-remote="horn"]');
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 300);
  } else {
    if (held.has(key)) return;
    held.add(key);
    updatePad();
  }
  remoteSend();
}

function remoteRelease(key) {
  if (!held.delete(key)) return;
  updatePad();
  remoteSend();
}

function remoteReleaseAll() {
  if (!held.size) return;
  held.clear();
  updatePad();
  remoteSend();
}

// keys belong to text fields, dropdowns and open dialogs; everywhere else they steer the robot
function remoteKeyAllowed(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || document.querySelector("dialog[open]")) return false;
  return !(e.target instanceof Element && e.target.closest("input, select, textarea"));
}

function setupRemote() {
  // capture phase: space must not also click the focused button or add a palette block
  document.addEventListener("keydown", e => {
    const key = REMOTE_KEYS[e.key];
    if (!key || !remoteKeyAllowed(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) remotePress(key);
  }, true);
  document.addEventListener("keyup", e => {
    const key = REMOTE_KEYS[e.key];
    if (!key) return;
    if (remoteKeyAllowed(e)) e.preventDefault();
    remoteRelease(key);
  }, true);
  window.addEventListener("blur", remoteReleaseAll);     // a keyup we never see must not leave it driving
  document.addEventListener("visibilitychange", remoteReleaseAll);

  document.querySelectorAll("[data-remote]").forEach(el => {
    const key = el.dataset.remote;
    el.addEventListener("pointerdown", e => { e.preventDefault(); el.setPointerCapture(e.pointerId); remotePress(key); });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, () => remoteRelease(key));
    el.addEventListener("contextmenu", e => e.preventDefault());   // long press on a tablet
  });

  // browsers only report controllers to secure pages (https or localhost); elsewhere the list just stays empty
  if (navigator.getGamepads && window.isSecureContext) setInterval(pollGamepad, 50);
  else $("#pad-hint").textContent = tr("🎮 Ein Controller geht nur, wenn die Seite als http://localhost:8000 geöffnet ist.");
}

// --- wiring ---------------------------------------------------------------------------------

function init() {
  load();
  renderPalette();
  renderProgram();
  refreshMine();
  setupDrop();
  requestAnimationFrame(drawProgress);
  setupRemote();

  const on = (action, fn) => document.querySelectorAll(`[data-action="${action}"]`).forEach(b => b.addEventListener("click", fn));
  on("run", run);
  on("stop", stop);
  on("save", openSave);
  on("load", openLoad);
  $("#btn-clear").addEventListener("click", () => {
    if (!program.length || !unsavedOk("simple", tr("Dein Programm ist nicht gespeichert. Trotzdem alles löschen?"))) return;
    program = [];
    save();
    renderProgram();
  });
  $("#btn-adv-clear").addEventListener("click", () => {
    if (!profi() || !unsavedOk("advanced", tr("Dein Programm ist nicht gespeichert. Trotzdem neu anfangen?"))) return;
    profi().reset();
    setSynced(null);
    current.advanced = { name: "", symbol: SYMBOLS[0] };
  });
  document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#btn-manage").addEventListener("click", openLoad);
  $("#save-confirm").addEventListener("click", confirmSave);
  $("#save-form").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.id === "save-name") { e.preventDefault(); confirmSave(); }
  });
  $("#status").addEventListener("click", openConnect);
  $("#btn-cal").addEventListener("click", openCal);
  const other = LANG === "de" ? "en" : "de";
  $("#btn-lang").textContent = other === "en" ? "English" : "Deutsch";
  $("#btn-lang").lang = other;
  $("#btn-lang").addEventListener("click", () => setLang(other));

  $("#port-refresh").addEventListener("click", refreshPorts);
  $("#connect-serial").addEventListener("click", () => connect("serial", $("#port-select").value));
  $("#ble-scan").addEventListener("click", scanBle);
  $("#wifi-scan").addEventListener("click", scanWifi);
  $("#connect-wifi").addEventListener("click", () => connect("wifi", $("#wifi-address").value.trim() || $("#wifi-select").value));
  $("#wifi-select").addEventListener("change", e => { if (e.target.value) $("#wifi-address").value = e.target.value; });
  $("#connect-ble").addEventListener("click", () => connect("ble", $("#ble-address").value.trim() || $("#ble-select").value));
  $("#ble-select").addEventListener("change", e => { if (e.target.value) $("#ble-address").value = e.target.value; });
  $("#disconnect").addEventListener("click", async () => {
    try { await api("/api/disconnect", {}); setMsg($("#dlg-connect-msg"), tr("Getrennt.")); } catch (e) { setMsg($("#dlg-connect-msg"), e.message, "err"); }
    poll();
  });

  calForm().addEventListener("input", refreshOutputs);
  document.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", () => calTest(b.dataset.test)));
  document.querySelectorAll("[data-fit]").forEach(b => b.addEventListener("click", () => calFit(b.dataset.fit)));
  $("#cal-save").addEventListener("click", calSave);
  $("#cal-stop").addEventListener("click", stop);

  let startMode = "simple";
  try {
    startMode = localStorage.getItem(MODE_KEY) || "simple";
    view = localStorage.getItem(VIEW_KEY) === "flow" ? "flow" : "blocks";
  } catch (_) { /* ignore */ }
  setMode(startMode);
  poll();
  listen();
  setInterval(poll, 3000);
}

init();
