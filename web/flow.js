"use strict";

// Profi mode's "Ablauf" view: the program as a structured flowchart that lays itself out. Boxes are joined by
// arrows from top to bottom, a question is a real fork ("ja" / "nein" lanes that join again below), a loop is an
// arrow back up. Kids never draw arrows: they put blocks onto them – tap a "+" on an arrow and then a block in the
// palette, or drag a block onto an arrow. So a program can't turn into spaghetti and always reads top to bottom.
//
// The document is a tree close to the compiler's syntax tree (see server/compiler.py); toAst() converts it.
//     { main: [stmt…], functions: { name: { id, params: [name…], body: [stmt…] } }, vars: [name…] }
// Statements are the compiler's ({ id, do, … }); values and conditions have their own small shapes, so a
// condition is picked from a menu ("Linie links schwarz?") instead of being built from nested blocks:
//     value: { k: "num", n } | { k: "var", name } | { k: "sensor", name: distance|light|timer } | { k: "random", lo, hi }
//            (the stopwatch in seconds; the robot counts milliseconds)
//     cond:  { k: "line", side: left|right|both, black } | { k: "button", pressed } | { k: "cmp", a: value, fn, v: value }
// Values are also blocks of their own in the palette ("Abstand", a variable, "Zufall"), dragged into a value slot
// (a number field, either side of a comparison) or onto a question.
//     both also { k: "expr", e }: a compiler expression the menus can't build (a formula from the "Blöcke" view),
//     kept as it is and shown as text; e null is an empty slot.
// loadAst() / exportAst() convert from / to the syntax tree, so the "Blöcke" view (advanced.js) can show the same
// program.
// Uses NOTES, noteLabel and showError from app.js (loaded after this file, used only once the page runs).

window.Flow = (() => {
  const COLORS = {      // the same as the Blockly mode's categories (advanced.js)
    move: "#4C97FF", sound: "#CF63CF", sensor: "#5CB1D6", control: "#FFAB19", math: "#59C059", vars: "#FF8C1A",
    mine: "#FF6680",
  };
  const STORE_KEY = "mbot-flow-v1";
  // layout, in px at zoom 1
  const GAP = 56;          // between two boxes: the arrow and its "+"
  const LANE_GAP = 48;     // between the "ja" and the "nein" lane
  const STUB = 16;         // from the tag on a question's side at least this far sideways to its lane
  const LOOP_PAD = 30;     // loop arrows: distance from the widest box inside the loop
  const JOIN = 24;         // lanes join this far below the longer one
  const BACK = 24;         // end of a loop's body -> the arrow back up
  const PAD = 14;          // the tinted area of a fork or loop reaches this far around it
  const PORT_W = 58, PORT_H = 28;   // the "ja" / "nein" / "fertig" tags (.f-port in style.css) …
  const PORT_IN = { hex: 16, box: 4 };   // … reach this far into the node's side (a ⬡'s empty tip, a box's padding)
  const MARGIN = 44;
  const EMPTY = 20;        // half the width of an empty lane (just its "+")
  const ZOOM = { min: 0.4, max: 2, step: 1.15 };
  const DRAG_START = 8;    // px the pointer must move before a press becomes a drag
  const DROP_RADIUS = 90;  // px around a "+" that still counts as dropping onto it
  const SLOT_RADIUS = 28;  // px around a value slot that still counts as dropping into it
  const MAX_NAME = 30;
  const HISTORY_MAX = 60;  // how many steps ↶ goes back

  const LOOPS = new Set(["repeat", "forever", "repeat_until"]);
  const TERMINAL = new Set(["forever", "end"]);          // nothing can come after these
  const num = n => ({ k: "num", n });
  const CMP = { "<": "<", ">": ">", "=": "=", "!=": "≠", "<=": "≤", ">=": "≥" };     // comparisons, as shown

  // category and shape of each statement; "make" gives a new one for the palette
  const DEFS = {
    move: { cat: "move" }, turn: { cat: "move" }, drive: { cat: "move" }, motors: { cat: "move" }, stop: { cat: "move" },
    beep: { cat: "sound" }, reset_timer: { cat: "sensor" },
    wait: { cat: "control" }, if: { cat: "control", shape: "hex" }, repeat: { cat: "control", shape: "loop" },
    forever: { cat: "control", shape: "loop" }, repeat_until: { cat: "control", shape: "hex" },
    wait_until: { cat: "control", shape: "hex" }, end: { cat: "control", shape: "pill" },
    set: { cat: "vars" }, change: { cat: "vars" }, call: { cat: "mine" },
  };

  const PALETTE = [
    { name: tr("Bewegung"), cat: "move", items: [
      [tr("fahre 1 Schritt"), () => ({ do: "move", dir: "forward", steps: 1 })],
      [tr("drehe 90°"), () => ({ do: "turn", dir: "left", deg: 90 })],
      [tr("fahre los"), () => ({ do: "drive", dir: "forward", power: num(50) })],
      [tr("Motoren einzeln"), () => ({ do: "motors", left: num(50), right: num(50) })],
      [tr("halte an"), () => ({ do: "stop" })]] },
    { name: tr("Klang"), cat: "sound", items: [
      [tr("spiele Ton"), () => ({ do: "beep", hz: num(880), sec: num(0.25), wait: true })],
      [tr("starte Ton"), () => ({ do: "beep", hz: num(440), sec: num(0.5), wait: false })]] },
    { name: tr("Steuerung"), cat: "control", items: [
      [tr("warte 1 Sek."), () => ({ do: "wait", sec: num(1) })],
      [tr("Frage: ja oder nein?"), () => ({ do: "if", cond: { k: "line", side: "left", black: true }, then: [], else: [] })],
      [tr("wiederhole 4 mal"), () => ({ do: "repeat", times: num(4), body: [] })],
      [tr("wiederhole fortlaufend"), () => ({ do: "forever", body: [] })],
      [tr("wiederhole bis …?"), () => ({ do: "repeat_until", cond: { k: "cmp", a: "distance", fn: "<", v: num(10) }, body: [] })],
      [tr("warte bis …?"), () => ({ do: "wait_until", cond: { k: "button", pressed: true } })],
      [tr("beende Programm"), () => ({ do: "end" })]] },
    { name: tr("Sensoren"), cat: "sensor", hint: tr("Werte: zieh sie in ein Feld oder auf eine Frage ⬡."), values: [
      [tr("📏 Abstand"), () => ({ k: "sensor", name: "distance" })],
      [tr("💡 Helligkeit"), () => ({ k: "sensor", name: "light" })],
      [tr("⏱ Stoppuhr"), () => ({ k: "sensor", name: "timer" })]], items: [
      [tr("Stoppuhr auf 0"), () => ({ do: "reset_timer" })]] },
    { name: tr("Rechnen"), cat: "math", values: [
      [tr("🎲 Zufall 1 bis 10"), () => ({ k: "random", lo: 1, hi: 10 })]], items: [] },
    { name: tr("Variablen"), cat: "vars", items: [
      [tr("setze Variable"), () => ({ do: "set", var: firstVar(), value: num(0) }), "var"],
      [tr("ändere Variable"), () => ({ do: "change", var: firstVar(), by: num(1) }), "var"]] },
  ];

  // --- state ------------------------------------------------------------------------------------

  let doc = emptyDoc();
  let view = null;             // null: the main program, else the name of the "Meine Blöcke" block shown
  let cursor = null;           // { arr, index }: where a tapped palette block goes
  let selected = null;         // id of the selected box
  let running = { block: null, top: null };
  let error = { id: null, msg: "" };
  let changeHandler = () => {};
  let scale = 1;
  let dirty = true;            // needs a render (the card was hidden when the document changed)
  let recenter = true;         // next render: scroll so "▶ Start" is in view (a new document or view)
  let ui = null;               // the DOM parts, once init() ran
  let targets = [];            // every "+" of the current render: { arr, index, btn }
  let idSeq = 0;

  function emptyDoc() { return { main: [], functions: {}, vars: [] }; }
  const newId = () => `f${Date.now().toString(36)}${(idSeq++).toString(36)}`;
  const firstVar = () => varsInView()[0] || "";
  const varsInView = () => [...doc.vars, ...(view !== null && doc.functions[view] ? doc.functions[view].params : [])];
  const currentSeq = () => (view === null ? doc.main : doc.functions[view].body);
  const bodiesOf = s => (s.do === "if" ? [s.then, s.else] : LOOPS.has(s.do) ? [s.body] : []);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const notify = msg => (typeof showError === "function" ? showError(msg) : alert(msg));
  const cleanName = n => String(n || "").split(/\s+/).filter(Boolean).join(" ");

  function walk(arr, fn) {
    for (const s of arr) {
      fn(s, arr);
      bodiesOf(s).forEach(b => walk(b, fn));
    }
  }
  function walkAll(fn) {
    walk(doc.main, fn);
    for (const f of Object.values(doc.functions)) walk(f.body, fn);
  }

  // where a statement is: { s, arr, index, view }
  function find(id) {
    const search = (arr, v) => {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].id === id) return { s: arr[i], arr, index: i, view: v };
        for (const b of bodiesOf(arr[i])) { const hit = search(b, v); if (hit) return hit; }
      }
      return null;
    };
    let hit = search(doc.main, null);
    for (const [name, f] of Object.entries(doc.functions)) hit = hit || search(f.body, name);
    return hit;
  }

  function arraysIn(s, out = new Set()) {
    for (const b of bodiesOf(s)) { out.add(b); b.forEach(c => arraysIn(c, out)); }
    return out;
  }

  // --- loading: whatever is stored, make it a well-formed document ---------------------------------

  function cleanValue(v, def) {
    if (typeof v === "number" && Number.isFinite(v)) return num(v);
    if (!v || typeof v !== "object") return num(def);
    if (v.k === "num" && Number.isFinite(Number(v.n))) return num(Number(v.n));
    if (v.k === "var" && typeof v.name === "string") return { k: "var", name: v.name };
    if (v.k === "sensor" && SENSOR_VALUES[v.name]) return { k: "sensor", name: v.name };
    if (v.k === "random") return { k: "random", lo: Number(v.lo) || 0, hi: Number(v.hi) || 0 };
    if (v.k === "expr") return { k: "expr", e: v.e && typeof v.e === "object" ? v.e : null };
    return num(def);
  }
  function cleanCond(c) {
    if (c && c.k === "line") return { k: "line", side: ["left", "right", "both"].includes(c.side) ? c.side : "left", black: c.black !== false };
    if (c && c.k === "button") return { k: "button", pressed: c.pressed !== false };
    if (c && c.k === "cmp") {
      const a = typeof c.a === "string"                // stored before both sides were values
        ? (c.a === "var" ? { k: "var", name: String(c.var || "") } : { k: "sensor", name: c.a }) : c.a;
      return { k: "cmp", a: cleanValue(a, 0), fn: CMP[c.fn] ? c.fn : "<", v: cleanValue(c.v, 10) };
    }
    if (c && c.k === "expr") return { k: "expr", e: c.e && typeof c.e === "object" ? c.e : null };
    return { k: "line", side: "left", black: true };
  }
  function cleanSeq(arr, seen) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(s => s && DEFS[s.do]).map(s => {
      const out = { ...s, id: typeof s.id === "string" && !seen.has(s.id) ? s.id : newId() };
      seen.add(out.id);
      if (out.do === "if") { out.then = cleanSeq(s.then, seen); out.else = cleanSeq(s.else, seen); }
      if (LOOPS.has(out.do)) out.body = cleanSeq(s.body, seen);
      if (["if", "repeat_until", "wait_until"].includes(out.do)) out.cond = cleanCond(s.cond);
      for (const [key, def] of [["power", 50], ["left", 50], ["right", 50], ["sec", 1], ["times", 4], ["value", 0], ["by", 1]]) {
        if (key in out) out[key] = cleanValue(out[key], def);
      }
      if (out.do === "beep") { out.hz = cleanValue(s.hz, 880); out.sec = cleanValue(s.sec, 0.25); }
      if (out.do === "call") out.args = Array.isArray(s.args) ? s.args.map(a => cleanValue(a, 0)) : [];
      return out;
    });
  }
  function cleanDoc(raw) {
    const d = emptyDoc(), seen = new Set();
    if (!raw || typeof raw !== "object") return d;
    d.vars = Array.isArray(raw.vars) ? [...new Set(raw.vars.map(cleanName).filter(Boolean))] : [];
    d.main = cleanSeq(raw.main, seen);
    for (const [name, f] of Object.entries(raw.functions || {})) {
      if (!cleanName(name) || !f) continue;
      d.functions[cleanName(name)] = { id: typeof f.id === "string" ? f.id : newId(),
        params: Array.isArray(f.params) ? f.params.map(cleanName).filter(Boolean) : [], body: cleanSeq(f.body, seen) };
    }
    // calls follow their block's inputs
    const all = [d.main, ...Object.values(d.functions).map(f => f.body)];
    all.forEach(arr => walk(arr, s => {
      const f = s.do === "call" && d.functions[s.name];
      if (f) s.args = f.params.map((_, i) => s.args[i] || num(0));
    }));
    return d;
  }

  // --- document -> compiler syntax tree -----------------------------------------------------------

  function expr(v) {
    switch (v && v.k) {
      case "num": return { op: "num", value: v.n };
      case "var": return { op: "var", name: v.name };
      case "sensor": return v.name === "timer" ? TIMER_SEC : { op: "sensor", name: v.name };
      case "random": return { op: "random", lo: { op: "num", value: v.lo }, hi: { op: "num", value: v.hi } };
      case "expr": return v.e;
      default: return null;            // the compiler explains
    }
  }

  const TIMER_MS = { op: "sensor", name: "timer" };
  const TIMER_SEC = { op: "bin", fn: "/", a: TIMER_MS, b: { op: "num", value: 1000 } };

  function condExpr(c) {
    if (c.k === "expr") return c.e;
    const sensor = name => ({ op: "sensor", name });
    const not = a => ({ op: "not", a });
    if (c.k === "line") {
      const l = sensor("line_left"), r = sensor("line_right");
      if (c.side === "both") return c.black ? { op: "bin", fn: "and", a: l, b: r } : { op: "bin", fn: "and", a: not(l), b: not(r) };
      const one = c.side === "left" ? l : r;
      return c.black ? one : not(one);
    }
    if (c.k === "button") return c.pressed ? sensor("button") : not(sensor("button"));
    // "Stoppuhr > 2,5 Sek." compares milliseconds (2500) instead of dividing the stopwatch (whole seconds only)
    if (c.a.k === "sensor" && c.a.name === "timer" && c.v.k === "num") {
      return { op: "bin", fn: c.fn, a: TIMER_MS, b: { op: "num", value: Math.round(c.v.n * 1000) } };
    }
    return { op: "bin", fn: c.fn, a: expr(c.a), b: expr(c.v) };
  }

  function astSeq(arr) {
    return arr.map(s => {
      const out = { id: s.id, do: s.do };
      switch (s.do) {
        case "move": return { ...out, dir: s.dir, steps: s.steps };
        case "turn": return { ...out, dir: s.dir, deg: s.deg };
        case "drive": return { ...out, dir: s.dir, power: expr(s.power) };
        case "motors": return { ...out, left: expr(s.left), right: expr(s.right) };
        case "beep": return { ...out, hz: expr(s.hz), sec: expr(s.sec), wait: s.wait };
        case "wait": return { ...out, sec: expr(s.sec) };
        case "if": return { ...out, cond: condExpr(s.cond), then: astSeq(s.then), else: astSeq(s.else) };
        case "repeat": return { ...out, times: expr(s.times), body: astSeq(s.body) };
        case "forever": return { ...out, body: astSeq(s.body) };
        case "repeat_until": return { ...out, cond: condExpr(s.cond), body: astSeq(s.body) };
        case "wait_until": return { ...out, cond: condExpr(s.cond) };
        case "set": return { ...out, var: s.var, value: expr(s.value) };
        case "change": return { ...out, var: s.var, by: expr(s.by) };
        case "call": return { ...out, name: s.name, args: s.args.map(expr) };
        default: return out;           // stop, reset_timer, end
      }
    });
  }

  function toAst() {
    if (!doc.main.length) throw new Error(tr("Setz Bausteine unter ▶ Start – tippe auf ein ＋ und dann auf einen Baustein."));
    return exportAst().ast;
  }

  // the whole program, also when it is empty, for the other view
  function exportAst() {
    const functions = {};
    for (const [name, f] of Object.entries(doc.functions)) functions[name] = { id: f.id, params: [...f.params], body: astSeq(f.body) };
    return { ast: { body: astSeq(doc.main), functions }, vars: [...doc.vars], loose: 0 };
  }

  // --- compiler syntax tree -> document (a program from the "Blöcke" view) ----------------------------------
  // Whatever the menus can show becomes a menu value / condition; everything else stays a formula ({k: "expr"}).

  const isNum = e => typeof e === "number" || (!!e && e.op === "num");
  const numOf = e => (typeof e === "number" ? e : Number(e.value));
  const isSensor = (e, name) => !!e && e.op === "sensor" && e.name === name;
  const isNot = (e, name) => !!e && e.op === "not" && isSensor(e.a, name);
  const FLIP = { "<": ">", ">": "<", "=": "=", "!=": "!=", "<=": ">=", ">=": "<=" };

  function valueFrom(e) {
    if (e == null) return { k: "expr", e: null };
    if (isNum(e)) return num(numOf(e));
    if (e.op === "var") return { k: "var", name: String(e.name || "") };
    if (e.op === "sensor" && SENSOR_VALUES[e.name] && e.name !== "timer") return { k: "sensor", name: e.name };
    if (e.op === "bin" && e.fn === "/" && isSensor(e.a, "timer") && isNum(e.b) && numOf(e.b) === 1000) return { k: "sensor", name: "timer" };
    if (e.op === "random" && isNum(e.lo) && isNum(e.hi)) return { k: "random", lo: numOf(e.lo), hi: numOf(e.hi) };
    return { k: "expr", e };
  }

  function condFrom(e) {
    if (!e || typeof e !== "object") return { k: "expr", e: null };
    for (const side of ["left", "right"]) {
      if (isSensor(e, `line_${side}`)) return { k: "line", side, black: true };
      if (isNot(e, `line_${side}`)) return { k: "line", side, black: false };
    }
    if (e.op === "bin" && e.fn === "and") {
      if (isSensor(e.a, "line_left") && isSensor(e.b, "line_right")) return { k: "line", side: "both", black: true };
      if (isNot(e.a, "line_left") && isNot(e.b, "line_right")) return { k: "line", side: "both", black: false };
    }
    if (isSensor(e, "button")) return { k: "button", pressed: true };
    if (isNot(e, "button")) return { k: "button", pressed: false };
    if (e.op === "bin" && CMP[e.fn]) {
      let { a, b, fn } = e;
      if (isNum(a) && !isNum(b)) [a, b, fn] = [b, a, FLIP[fn]];     // "10 > Abstand" reads better as "Abstand < 10"
      if (isSensor(a, "timer") && isNum(b)) return { k: "cmp", a: { k: "sensor", name: "timer" }, fn, v: num(numOf(b) / 1000) };
      return { k: "cmp", a: valueFrom(a), fn, v: valueFrom(b) };
    }
    return { k: "expr", e };
  }

  function seqFrom(arr) {
    const out = [];
    for (const s of Array.isArray(arr) ? arr : []) {
      const c = s && DEFS[s.do] ? stmtFrom(s) : null;
      if (c) out.push(c);
    }
    return out;
  }

  function stmtFrom(s) {
    const out = { id: String(s.id || newId()), do: s.do };
    switch (s.do) {
      case "move": return { ...out, dir: s.dir === "backward" ? "backward" : "forward", steps: Number(s.steps) || 1 };
      case "turn": return { ...out, dir: s.dir === "right" ? "right" : "left", deg: Number(s.deg) || 90 };
      case "drive": return { ...out, dir: s.dir, power: valueFrom(s.power) };
      case "motors": return { ...out, left: valueFrom(s.left), right: valueFrom(s.right) };
      case "beep": return { ...out, hz: valueFrom(s.hz), sec: valueFrom(s.sec), wait: s.wait !== false };
      case "wait": return { ...out, sec: valueFrom(s.sec) };
      case "if": return { ...out, cond: condFrom(s.cond), then: seqFrom(s.then), else: seqFrom(s.else) };
      case "repeat": return { ...out, times: valueFrom(s.times), body: seqFrom(s.body) };
      case "forever": return { ...out, body: seqFrom(s.body) };
      case "repeat_until": return { ...out, cond: condFrom(s.cond), body: seqFrom(s.body) };
      case "wait_until": return { ...out, cond: condFrom(s.cond) };
      case "set": return { ...out, var: String(s.var || ""), value: valueFrom(s.value) };
      case "change": return { ...out, var: String(s.var || ""), by: valueFrom(s.by) };
      case "call": return { ...out, name: String(s.name || ""), args: (s.args || []).map(valueFrom) };
      default: return out;
    }
  }

  function loadAst(ast, vars = []) {
    const d = { main: seqFrom(ast && ast.body), functions: {}, vars: [...vars] };
    for (const [name, f] of Object.entries((ast && ast.functions) || {})) {
      d.functions[name] = { id: f.id, params: [...(f.params || [])], body: seqFrom(f.body) };
    }
    load(d);
  }

  function draftAst() {
    try { return toAst(); } catch (_) { return { body: [] }; }
  }

  // --- tiny DOM helpers ----------------------------------------------------------------------------

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
    return e;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  }

  // --- controls inside the boxes --------------------------------------------------------------------

  function choice(obj, key, options, aria) {
    const opts = options.some(([v]) => v === obj[key]) ? options : [...options, [obj[key], String(obj[key])]];
    return el("select", { class: "f-in", "aria-label": aria, onchange: e => { obj[key] = e.target.value; changed(); } },
      opts.map(([v, t]) => el("option", { value: v, selected: v === obj[key] }, t)));
  }

  function numberInput(obj, key, { min = -1e6, max = 1e6, aria, wrap = n => n, unwrap = n => n, layout = false }) {
    const input = el("input", {
      class: "f-in f-num", type: "number", inputmode: "decimal", step: "any", min, max, "aria-label": aria,
      value: unwrap(obj[key]),
      onchange: e => {
        const v = Number(String(e.target.value).replace(",", "."));
        if (e.target.value !== "" && Number.isFinite(v)) obj[key] = wrap(clamp(v, min, max));
        e.target.value = unwrap(obj[key]);
        changed({ layout });
      },
    });
    return input;
  }

  const SENSOR_VALUES = { distance: tr("📏 Abstand"), light: tr("💡 Helligkeit"), timer: tr("⏱ Stoppuhr") };
  function valueText(v) {
    if (v.k === "num") return fmtNum(v.n);
    if (v.k === "var") return v.name || "?";
    if (v.k === "sensor") return SENSOR_VALUES[v.name];
    if (v.k === "expr") return exprText(v.e);
    return tr("🎲 {lo} bis {hi}", { lo: fmtNum(v.lo), hi: fmtNum(v.hi) });
  }

  // a formula as text, the way the "Blöcke" view says it
  const SENSOR_TEXT = { distance: tr("Abstand"), light: tr("Helligkeit"), button: tr("Taste gedrückt"), timer: tr("Stoppuhr (ms)"),
                        line_left: tr("Linie links schwarz"), line_right: tr("Linie rechts schwarz") };
  const OPS = { "+": "+", "-": "−", "*": "×", "/": "÷", "%": tr("Rest"), "<": "<", ">": ">", "=": "=", "<=": "≤", ">=": "≥",
                "!=": "≠", and: tr("und"), or: tr("oder") };
  function exprText(e, nested = false) {
    if (e == null) return "?";
    if (typeof e === "number") return fmtNum(e);
    switch (e.op) {
      case "num": return fmtNum(e.value);
      case "var": return e.name || "?";
      case "sensor": return SENSOR_TEXT[e.name] || e.name;
      case "random": return tr("Zufall {lo} bis {hi}", { lo: exprText(e.lo, true), hi: exprText(e.hi, true) });
      case "not": return tr("nicht {a}", { a: exprText(e.a, true) });
      case "neg": return `−${exprText(e.a, true)}`;
      case "bin": {
        const text = `${exprText(e.a, true)} ${OPS[e.fn] || e.fn} ${exprText(e.b, true)}`;
        return nested ? `(${text})` : text;
      }
      default: return "?";
    }
  }

  // a value slot: a number typed in directly, or (via ▾) a variable, a sensor, a random number
  // a value slot: a number typed in, or a value block (variable, sensor, random number) – dropped in from the
  // palette or picked via ▾
  function valueControl(obj, key, aria, min, max) {
    const v = obj[key];
    const pop = e => openValuePop(e.currentTarget, obj, key);
    let parts;
    if (v.k === "num") {
      parts = [numberInput(obj, key, { min, max, aria, wrap: n => num(n), unwrap: x => x.n }),
        el("button", { type: "button", class: "f-more", "aria-label": tr("{what}: Variable, Sensor oder Zufall", { what: aria }),
                       title: tr("Variable, Sensor oder Zufallszahl"), onclick: pop }, "▾")];
    } else if (v.k === "random") {
      parts = [el("span", { class: "f-chip f-random" },
        el("button", { type: "button", class: "f-dice", "aria-label": tr("{what}: ändern", { what: aria }), title: tr("Zufallszahl – antippen zum Ändern"), onclick: pop }, "🎲"),
        numberInput(v, "lo", { aria: tr("von"), wrap: Math.round }), el("span", {}, tr("bis")), numberInput(v, "hi", { aria: tr("bis"), wrap: Math.round }))];
    } else {
      parts = [el("button", { type: "button", class: `f-chip ${{ var: "f-var", sensor: "f-sensor", expr: "f-formula" }[v.k] || ""}`,
                              "aria-label": aria, title: v.k === "expr" ? FORMULA_HINT : null, onclick: pop }, valueText(v))];
    }
    return slot(el("span", { class: "f-val" }, ...parts), obj, key);
  }

  let slots = [];              // every value slot of the current render: { el, obj, key, cond }
  function slot(e, obj, key, cond = false) {
    e.classList.add("f-slot");
    slots.push({ el: e, obj, key, cond });
    return e;
  }

  // a value dropped into a slot; on a question that isn't a comparison it becomes "value > 0"
  function putValue(target, value) {
    if (target.cond) target.obj.cond = { k: "cmp", a: value, fn: ">", v: num(0) };
    else target.obj[target.key] = value;
    changed();
  }
  const FORMULA_HINT = tr("Eine Formel aus der Blöcke-Ansicht. Antippen, um sie zu ersetzen – ändern geht in „Blöcke“.");

  function varSelect(s) {
    const names = varsInView();
    const opts = names.includes(s.var) || !s.var ? names : [...names, s.var];
    return el("select", {
      class: "f-in", "aria-label": tr("Variable"),
      onchange: e => {
        if (e.target.value === "\u0000new") {
          const name = newVariable();
          if (name) s.var = name;
          changed();
          return;
        }
        s.var = e.target.value;
        changed();
      },
    }, !s.var ? el("option", { value: "", selected: true }, "–") : null,
       opts.map(n => el("option", { value: n, selected: n === s.var }, n)),
       el("option", { value: "\u0000new" }, tr("＋ neu …")));
  }

  // the pitch: a note from the menu (or, via ▾, a variable, a sensor …)
  function noteControl(s) {
    if (s.hz.k !== "num") return valueControl(s, "hz", tr("Ton"));
    const hz = s.hz.n;
    const notes = typeof NOTES !== "undefined" ? NOTES.map(n => [String(n.hz), n.name]) : [];
    const label = typeof noteLabel === "function" ? noteLabel : x => `${x} Hz`;
    const opts = notes.some(([v]) => Number(v) === hz) ? notes : [...notes, [String(hz), label(hz)]];
    return slot(el("span", { class: "f-val" },
      el("select", { class: "f-in", "aria-label": tr("Ton"), onchange: e => { s.hz = num(Number(e.target.value)); changed({ layout: false }); } },
        opts.map(([v, t]) => el("option", { value: v, selected: Number(v) === hz }, t))),
      el("button", { type: "button", class: "f-more", "aria-label": tr("{what}: Variable, Sensor oder Zufall", { what: tr("Ton") }),
                     onclick: e => openValuePop(e.currentTarget, s, "hz") }, "▾")), s, "hz");
  }


  function condText(c) {
    if (c.k === "line") return LINE_TEXT[c.side][c.black ? 0 : 1];
    if (c.k === "button") return c.pressed ? tr("Taste gedrückt?") : tr("Taste nicht gedrückt?");
    if (c.k === "expr") return `${exprText(c.e)}?`;
    return `${valueText(c.a)} ${CMP[c.fn]} ${valueText(c.v)}${c.v.k === "num" ? unitOf(c.a) : ""}?`;
  }
  const LINE_TEXT = { left: [tr("Linie links schwarz?"), tr("Linie links weiß?")], right: [tr("Linie rechts schwarz?"), tr("Linie rechts weiß?")],
                      both: [tr("Linie unter beiden schwarz?"), tr("Linie unter beiden weiß?")] };
  const unitOf = v => (v.k === "sensor" ? { distance: " cm", timer: ` ${tr("Sek.")}` }[v.name] || "" : "");

  // a question: a comparison shows both sides as value slots; anything else is a chip from the menu (and a value
  // dropped on it turns it into a comparison)
  function condControl(s) {
    const c = s.cond;
    const more = el("button", { type: "button", class: "f-more f-cond-more", "aria-label": tr("Andere Frage wählen"),
                                title: tr("Andere Frage wählen (Linie, Taste, …)"), onclick: e => openCondPop(e.currentTarget, s) }, "▾");
    if (c.k !== "cmp") {
      const chip = el("button", { type: "button", class: `f-chip f-cond${c.k === "expr" ? " f-formula" : ""}`,
                                  "aria-label": tr("Frage ändern"), title: c.k === "expr" ? FORMULA_HINT : null,
                                  onclick: e => openCondPop(e.currentTarget, s) }, condText(c));
      slot(chip, s, "cond", true);
      return chip;
    }
    const fn = el("select", { class: "f-in f-op", "aria-label": tr("Vergleich"), onchange: e => { c.fn = e.target.value; changed({ layout: false }); } },
      Object.entries(CMP).map(([v, label]) => el("option", { value: v, selected: v === c.fn }, label)));
    const unit = c.v.k === "num" ? unitOf(c.a).trim() : "";
    return el("span", { class: "f-cmp" }, valueControl(c, "a", tr("linke Seite")), fn, valueControl(c, "v", tr("rechte Seite")),
      unit ? el("span", { class: "f-t" }, unit) : null, el("span", { class: "f-t" }, "?"), more);
  }

  // what a statement's box says, with its controls
  function content(s) {
    const t = text => el("span", { class: "f-t" }, text);
    switch (s.do) {
      case "move": return [t(tr("fahre")), choice(s, "dir", [["forward", tr("vorwärts")], ["backward", tr("rückwärts")]], tr("Richtung")),
        numberInput(s, "steps", { min: 0.1, max: 50, aria: tr("Schritte"), layout: true }), t(s.steps === 1 ? tr("Schritt") : tr("Schritte"))];
      case "turn": return [t(tr("drehe")), choice(s, "dir", [["left", tr("links")], ["right", tr("rechts")]], tr("Richtung")),
        numberInput(s, "deg", { min: 5, max: 720, aria: tr("Winkel") }), t("°")];
      case "drive": return [t(tr("fahre los")), choice(s, "dir", [["forward", tr("vorwärts")], ["backward", tr("rückwärts")],
        ["left", tr("links herum")], ["right", tr("rechts herum")]], tr("Richtung")), t(tr("mit")), valueControl(s, "power", tr("Tempo"), 0, 100), t("%")];
      case "motors": return [t(tr("Motor links")), valueControl(s, "left", tr("linker Motor"), -100, 100), t(tr("% rechts")),
        valueControl(s, "right", tr("rechter Motor"), -100, 100), t("%")];
      case "stop": return [t(tr("halte an"))];
      case "beep": return [t(s.wait ? tr("spiele Ton") : tr("starte Ton")), noteControl(s), t(tr("für")),
        valueControl(s, "sec", tr("Dauer"), 0.05, 30), t(tr("Sek."))];
      case "reset_timer": return [t(tr("⏱ Stoppuhr auf 0"))];
      case "wait": return [t(tr("warte")), valueControl(s, "sec", tr("Sekunden"), 0, 3600), t(tr("Sek."))];
      case "if": return [condControl(s)];
      case "repeat": return [t(tr("↻ wiederhole")), valueControl(s, "times", tr("wie oft"), 0, 10000), t(tr("mal"))];
      case "forever": return [t(tr("↻ wiederhole fortlaufend"))];
      case "repeat_until": return [t(tr("↻ wiederhole bis")), condControl(s)];
      case "wait_until": return [t(tr("warte bis")), condControl(s)];
      case "end": return [t(tr("■ Programm beenden"))];
      case "set": return [t(tr("setze")), varSelect(s), t(tr("auf")), valueControl(s, "value", tr("Wert"))];
      case "change": return [t(tr("ändere")), varSelect(s), t(tr("um")), valueControl(s, "by", tr("um wie viel"))];
      case "call": {
        const f = doc.functions[s.name];
        return [t(`🧩 ${s.name}`), ...(f ? f.params.flatMap((p, i) => [t(`${p}:`), valueControl(s.args, i, p)]) : [t(tr("(gibt es nicht mehr)"))])];
      }
      default: return [t(s.do)];
    }
  }

  // --- popovers: picking a value or a condition --------------------------------------------------------

  let pop = null;
  function closePop() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener("pointerdown", popOutside, true);
    document.removeEventListener("keydown", popKey, true);
  }
  function popOutside(e) { if (pop && !pop.contains(e.target)) closePop(); }
  function popKey(e) { if (e.key === "Escape") { e.stopPropagation(); closePop(); } }

  function openPop(anchor, title, ...sections) {
    closePop();
    pop = el("div", { class: "f-pop", role: "dialog", "aria-label": title }, el("b", { class: "f-pop-title" }, title), ...sections);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
    pop.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    document.addEventListener("pointerdown", popOutside, true);
    document.addEventListener("keydown", popKey, true);
    const first = pop.querySelector("input, button");     // not with a finger: that would pop up the keyboard
    if (first && matchMedia("(pointer: fine)").matches) first.focus();
  }
  const popRow = (...kids) => el("div", { class: "f-pop-row" }, ...kids);
  const popBtn = (label, fn, cls = "") => el("button", { type: "button", class: `f-pop-btn ${cls}`, onclick: () => { fn(); closePop(); changed(); } }, label);
  const popNum = (value, aria) => el("input", { type: "number", class: "f-in f-num", inputmode: "decimal", step: "any", value, "aria-label": aria });
  const readNum = (input, fallback) => {
    const v = Number(String(input.value).replace(",", "."));
    return input.value !== "" && Number.isFinite(v) ? v : fallback;
  };
  const okOnEnter = (inputs, ok) => inputs.forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } }));

  function openValuePop(anchor, obj, key) {
    const v = obj[key];
    const n = popNum(v.k === "num" ? v.n : 0, tr("Zahl"));
    const okN = popBtn("✓", () => { obj[key] = num(readNum(n, 0)); }, "ok");
    okOnEnter([n], okN);
    const lo = popNum(v.k === "random" ? v.lo : 1, tr("von")), hi = popNum(v.k === "random" ? v.hi : 10, tr("bis"));
    const okR = popBtn("✓", () => { obj[key] = { k: "random", lo: Math.round(readNum(lo, 1)), hi: Math.round(readNum(hi, 10)) }; }, "ok");
    okOnEnter([lo, hi], okR);
    const vars = varsInView();
    openPop(anchor, tr("Was soll hier stehen?"),
      v.k === "expr" ? el("p", { class: "f-pop-now" }, tr("Jetzt: {now} (Formel aus „Blöcke“)", { now: valueText(v) })) : null,
      popRow(el("span", { class: "f-pop-label" }, tr("Zahl")), n, okN),
      popRow(el("span", { class: "f-pop-label" }, tr("Variable")),
        ...vars.map(name => popBtn(name, () => { obj[key] = { k: "var", name }; }, "var")),
        popBtn(tr("＋ neu"), () => { const name = newVariable(); if (name) obj[key] = { k: "var", name }; }, "ghost")),
      popRow(el("span", { class: "f-pop-label" }, tr("Sensor")),
        ...Object.entries(SENSOR_VALUES).map(([name, label]) => popBtn(label, () => { obj[key] = { k: "sensor", name }; }, "sensor"))),
      popRow(el("span", { class: "f-pop-label" }, tr("🎲 Zufall")), lo, el("span", {}, tr("bis")), hi, okR));
  }

  function openCondPop(anchor, s) {
    const c = s.cond;
    const set = cond => () => { s.cond = cond; };
    const line = (side, black, label) => popBtn(label, set({ k: "line", side, black }), `line ${c.k === "line" && c.side === side && c.black === black ? "on" : ""}`);
    const cmpRow = (a, label, unit, fns, def) => {
      const same = c.k === "cmp" && (a === "var" ? c.a.k === "var" : c.a.k === "sensor" && c.a.name === a);
      const fn = el("select", { class: "f-in", "aria-label": tr("Vergleich") },
        fns.map(f => el("option", { value: f, selected: same ? c.fn === f : f === fns[0] }, CMP[f])));
      const value = popNum(same && c.v.k === "num" ? c.v.n : def, label);
      const varPick = a === "var" ? el("select", { class: "f-in", "aria-label": tr("Variable") },
        varsInView().map(n => el("option", { value: n, selected: same && c.a.name === n }, n))) : null;
      const ok = popBtn("✓", () => {
        s.cond = { k: "cmp", a: varPick ? { k: "var", name: varPick.value } : { k: "sensor", name: a }, fn: fn.value, v: num(readNum(value, def)) };
      }, "ok");
      okOnEnter([value], ok);
      return popRow(el("span", { class: "f-pop-label" }, label), varPick, fn, value, unit ? el("span", {}, unit) : null, ok);
    };
    openPop(anchor, tr("Was soll der Roboter prüfen?"),
      c.k === "expr" ? el("p", { class: "f-pop-now" }, tr("Jetzt: {now} (Formel aus „Blöcke“)", { now: condText(c) })) : null,
      popRow(el("span", { class: "f-pop-label" }, tr("Linie")),
        line("left", true, tr("links schwarz")), line("right", true, tr("rechts schwarz")), line("both", true, tr("beide schwarz")),
        line("left", false, tr("links weiß")), line("right", false, tr("rechts weiß")), line("both", false, tr("beide weiß"))),
      popRow(el("span", { class: "f-pop-label" }, tr("Taste")),
        popBtn(tr("gedrückt"), set({ k: "button", pressed: true })), popBtn(tr("nicht gedrückt"), set({ k: "button", pressed: false }))),
      cmpRow("distance", tr("📏 Abstand"), "cm", ["<", ">"], 10),
      cmpRow("light", tr("💡 Helligkeit"), "", ["<", ">"], 500),
      cmpRow("timer", tr("⏱ Stoppuhr"), tr("Sek."), [">", "<"], 5),
      varsInView().length ? cmpRow("var", tr("Variable"), "", ["=", "<", ">", "!=", "<=", ">="], 0) : null);
  }

  // --- names: variables, "Meine Blöcke", their inputs ------------------------------------------------

  function askName(question, initial, taken) {
    let value = initial;
    for (;;) {
      const raw = prompt(question, value);
      if (raw === null) return null;
      const name = cleanName(raw);
      if (!name) return null;
      const problem = name.length > MAX_NAME ? tr("Höchstens {n} Zeichen.", { n: MAX_NAME }) : taken(name);
      if (!problem) return name;
      alert(problem);
      value = name;
    }
  }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  function newVariable() {
    const name = askName(tr("Wie soll die neue Variable heißen?"), "", n =>
      varsInView().some(v => same(v, n)) ? tr("„{name}“ gibt es schon.", { name: n }) : null);
    if (name) { doc.vars.push(name); renderPalette(); }
    return name;
  }

  function callsTo(name, fn) { walkAll(s => { if (s.do === "call" && s.name === name) fn(s); }); }

  function newFunction() {
    const name = askName(tr("Wie soll dein neuer Block heißen?"), "", n =>
      Object.keys(doc.functions).some(f => same(f, n)) ? tr("Einen Block „{name}“ gibt es schon.", { name: n }) : null);
    if (!name) return;
    doc.functions[name] = { id: newId(), params: [], body: [] };
    show(name);
    changed();
  }

  function renameFunction(old) {
    const name = askName(tr("Neuer Name für den Block:"), old, n =>
      Object.keys(doc.functions).some(f => same(f, n) && f !== old) ? tr("Einen Block „{name}“ gibt es schon.", { name: n }) : null);
    if (!name || name === old) return;
    doc.functions = Object.fromEntries(Object.entries(doc.functions).map(([k, f]) => [k === old ? name : k, f]));
    callsTo(old, s => { s.name = name; });
    if (view === old) view = name;
    changed();
  }

  function deleteFunction(name) {
    let used = false;
    callsTo(name, () => { used = true; });
    if (used) { notify(tr("„{name}“ wird noch benutzt. Nimm es zuerst überall heraus.", { name })); return; }
    delete doc.functions[name];
    show(null);
    changed();
    toast(tr("Block „{name}“ gelöscht.", { name }));
  }

  function addParam(name) {
    const f = doc.functions[name];
    const p = askName(tr("Wie soll die Eingabe heißen? (z. B. „Strecke“)"), "", n =>
      f.params.some(q => same(q, n)) ? tr("„{name}“ gibt es schon.", { name: n }) : null);
    if (!p) return;
    f.params.push(p);
    callsTo(name, s => s.args.push(num(0)));
    changed();
  }

  function removeParam(name, i) {
    const f = doc.functions[name];
    const [gone] = f.params.splice(i, 1);
    callsTo(name, s => s.args.splice(i, 1));
    changed();
    toast(tr("Eingabe „{name}“ entfernt.", { name: gone }));
  }

  // --- editing -----------------------------------------------------------------------------------------

  function defaultCursor() {
    const arr = currentSeq();
    const last = arr[arr.length - 1];
    return { arr, index: last && TERMINAL.has(last.do) ? arr.length - 1 : arr.length };
  }

  function cursorValid() {
    if (!cursor) return false;
    const seq = currentSeq();
    let found = cursor.arr === seq;
    if (!found) walk(seq, s => { if (bodiesOf(s).includes(cursor.arr)) found = true; });
    return found && cursor.index <= cursor.arr.length && !cursor.arr.slice(0, cursor.index).some(s => TERMINAL.has(s.do));
  }

  // nothing can come after "wiederhole fortlaufend" or "beende Programm"
  function terminalProblem(s, arr, index) {
    if (!TERMINAL.has(s.do) || index === arr.length) return null;
    return s.do === "forever" ? tr("„wiederhole fortlaufend“ hört nie auf – danach kann nichts mehr kommen. Setz es ans Ende.")
                              : tr("Nach „beende Programm“ kommt nichts mehr – setz es ans Ende.");
  }

  function insert(s, arr, index) {
    const problem = terminalProblem(s, arr, index);
    if (problem) { notify(problem); return false; }
    s.id = s.id || newId();
    arr.splice(index, 0, s);
    // tapping on goes on inside a new fork or loop ("ja" lane, loop body), else right after the new box
    cursor = bodiesOf(s).length ? { arr: bodiesOf(s)[0], index: 0 } : TERMINAL.has(s.do) ? { arr, index } : { arr, index: index + 1 };
    selected = null;
    changed();
    return true;
  }

  function addFromPalette(make, needsVar) {
    if (needsVar && !varsInView().length && !newVariable()) return;
    if (!cursorValid()) cursor = defaultCursor();
    insert(make(), cursor.arr, cursor.index);
  }

  function filled(s) { return bodiesOf(s).some(b => b.length); }

  function remove(id) {
    const hit = find(id);
    if (!hit) return;
    hit.arr.splice(hit.index, 1);
    if (selected === id) selected = null;
    changed();
    toast(filled(hit.s) ? tr("Gelöscht – mit allem, was darin war.") : tr("Gelöscht."));     // no "are you sure?": ↶ brings it back
  }

  function cloneStmt(s) {
    const c = JSON.parse(JSON.stringify(s));
    const fresh = x => { x.id = newId(); bodiesOf(x).forEach(b => b.forEach(fresh)); };
    fresh(c);
    return c;
  }

  function duplicate(id) {
    const hit = find(id);
    if (!hit) return;
    const copy = cloneStmt(hit.s);
    if (terminalProblem(copy, hit.arr, hit.index + 1)) { notify(tr("Das geht hier nicht – danach kann nichts mehr kommen.")); return; }
    hit.arr.splice(hit.index + 1, 0, copy);
    selected = copy.id;
    changed();
  }

  // move an existing statement onto the "+" target (arr, index)
  function move(id, arr, index) {
    const hit = find(id);
    if (!hit || arraysIn(hit.s).has(arr)) return;
    const at = hit.arr === arr && hit.index < index ? index - 1 : index;
    hit.arr.splice(hit.index, 1);
    const problem = terminalProblem(hit.s, arr, at);
    if (problem) { hit.arr.splice(hit.index, 0, hit.s); notify(problem); return; }
    arr.splice(at, 0, hit.s);
    changed();
  }

  // every change goes through here: remember the version before (↶), draw again (unless only a number changed),
  // store, recompile
  let storeTimer = null;
  let history = [];            // earlier versions of the document (JSON), newest last
  let now = null;              // the document as it is (JSON)
  function changed({ layout = true } = {}) {
    const next = JSON.stringify(doc);
    if (now !== null && next !== now) {
      history.push(now);
      if (history.length > HISTORY_MAX) history.shift();
    }
    now = next;
    if (layout) render(); else updateUndo();
    store();
  }

  function store() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(doc)); } catch (_) { /* ignore */ }
      changeHandler();
    }, 250);
  }

  function undo() {
    if (!history.length) return;
    now = history.pop();
    doc = cleanDoc(JSON.parse(now));
    if (view !== null && !doc.functions[view]) view = null;
    cursor = null;
    selected = null;
    hideToast();
    render();
    store();
  }

  function updateUndo() {
    const btn = ui && ui.tabs.querySelector(".f-undo");
    if (btn) btn.disabled = !history.length;
  }

  // a short note at the bottom of the chart, with ↶
  let toastTimer = null;
  function toast(msg, withUndo = true) {
    if (!ui) return;
    ui.toast.replaceChildren(el("span", {}, msg),
      withUndo ? el("button", { type: "button", class: "f-tool", onclick: undo }, tr("↶ Rückgängig")) : null);
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() { if (ui) ui.toast.hidden = true; }

  // --- layout ----------------------------------------------------------------------------------------
  // Every part reports how far it reaches left (l) and right (r) of its centre line, its height (h) and whether
  // the flow comes out at the bottom (open); place(x, y) then puts it with its centre line at x, its top at y.
  // Each statement's lines go into its own SVG group and its outline is remembered (boxes), so a fork or a loop
  // can be dragged as a whole.

  let boxes = new Map();       // statement id -> { x, y, w, h }: the area it takes, in chart coordinates

  // a polyline with rounded corners
  function rounded(points, radius = 16) {
    const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
      const d1 = Math.hypot(x - px, y - py), d2 = Math.hypot(nx - x, ny - y), k = Math.min(radius, d1 / 2, d2 / 2);
      d += ` L${x - (x - px) / d1 * k} ${y - (y - py) / d1 * k} Q${x} ${y} ${x + (nx - x) / d2 * k} ${y + (ny - y) / d2 * k}`;
    }
    const [lx, ly] = pts[pts.length - 1];
    return `${d} L${lx} ${ly}`;
  }

  function render() {
    if (!ui) return;
    if (!ui.root.offsetParent) { dirty = true; return; }      // hidden: measuring would give 0
    dirty = false;
    closePop();
    if (view !== null && !doc.functions[view]) view = null;
    if (!cursorValid()) cursor = defaultCursor();
    renderTabs();
    renderPalette();

    const { layer, svg } = ui;
    layer.replaceChildren();
    svg.replaceChildren(svgEl("defs", {}), svgEl("g", { class: "f-regions" }), svgEl("g", { class: "f-lines" }));
    svg.firstChild.append(...markerDefs());
    const [, regions, lines] = svg.children;
    targets = [];
    slots = [];
    boxes = new Map();

    // 1. every box into the page, so it can be measured
    const nodes = new Map();
    const make = s => {
      const e = nodeEl(s);
      layer.append(e);
      nodes.set(s, e);
      bodiesOf(s).forEach(b => b.forEach(make));
    };
    const seq = currentSeq();
    const start = startEl(), stop = endEl();
    layer.append(start, stop);
    seq.forEach(make);
    const size = new Map([...nodes].map(([s, e]) => [s, { w: e.offsetWidth, h: e.offsetHeight }]));

    // 2. drawing primitives
    let group = lines;           // where lines go: the group of the statement being placed
    const pos = (e, x, y) => { e.style.left = `${Math.round(x)}px`; e.style.top = `${Math.round(y)}px`; };
    const line = (points, { arrow = false, cls = "" } = {}) => group.append(svgEl("path", {
      d: rounded(points), class: `f-line ${cls}`, ...(arrow ? { "marker-end": `url(#f-arrow${cls ? `-${cls}` : ""})` } : {}) }));
    const region = (x, y, w, h, owner) => regions.append(svgEl("rect", { x, y, width: w, height: h, rx: 22, class: "f-region", "data-owner": owner }));
    // a "ja" / "nein" / "fertig" tag, centred on (x, y)
    const port = (x, y, text, cls, owner) => {
      const p = el("span", { class: `f-port ${cls}`, "data-owner": owner, "aria-hidden": "true" }, text);
      pos(p, x - PORT_W / 2, y - PORT_H / 2);
      layer.append(p);
    };
    const plus = (x, y, arr, index) => {
      const btn = el("button", { type: "button", class: "f-plus", "aria-label": tr("Hier einfügen"), title: tr("Hier einfügen: tippe danach auf einen Baustein") }, "+");
      pos(btn, x, y);
      btn.addEventListener("click", () => { if (dragJustEnded()) return; cursor = { arr, index }; markCursor(); });
      layer.append(btn);
      targets.push({ arr, index, btn });
    };

    function seqLayout(arr, tailArrow = false) {
      const items = arr.map(stmtLayout);
      const ends = items.length > 0 && !items[items.length - 1].open;
      const reach = side => Math.max(EMPTY, ...items.map(i => i[side]));
      return {
        l: reach("l"), r: reach("r"), open: !ends,
        h: items.reduce((sum, i) => sum + i.h, 0) + GAP * (items.length + (ends ? 0 : 1)),
        place(x, y) {
          items.forEach((it, i) => {
            line([[x, y], [x, y + GAP]], { arrow: true });
            plus(x, y + GAP / 2, arr, i);
            y += GAP;
            it.place(x, y);
            y += it.h;
          });
          if (!ends) {
            line([[x, y], [x, y + GAP]], { arrow: tailArrow });
            plus(x, y + GAP / 2, arr, items.length);
          }
        },
      };
    }

    function stmtLayout(s) {
      const lay = shapeLayout(s), place = lay.place;
      lay.place = (x, y) => {
        boxes.set(s.id, { x: x - lay.l, y: y - PAD - 8, w: lay.l + lay.r, h: lay.h + 2 * PAD + 8 });
        const outer = group;
        group = svgEl("g", { "data-owner": s.id });
        outer.append(group);
        place(x, y);
        group = outer;
      };
      return lay;
    }

    function shapeLayout(s) {
      const e = nodes.get(s), { w, h } = size.get(s), hw = w / 2, my = h / 2;
      const box = (x, y) => pos(e, x - hw, y);
      const tag = hw + PORT_W / 2 - PORT_IN[DEFS[s.do].shape === "hex" ? "hex" : "box"];  // a tag on the node's side: its centre …
      const tip = tag + PORT_W / 2;           // … and its outer end, where its line starts
      if (s.do === "if") {
        // one element: the question with its "ja" and "nein" tags, both lanes and where they join, on a tinted area
        const ja = seqLayout(s.then), nein = seqLayout(s.else);
        const cxL = -Math.max(LANE_GAP / 2 + ja.r, tip + STUB), cxR = Math.max(LANE_GAP / 2 + nein.l, tip + STUB);
        const lanes = Math.max(ja.h, nein.h), open = ja.open || nein.open;
        const height = h + lanes + (open ? JOIN : 0);
        const l = Math.max(tip, -cxL + ja.l) + PAD, r = Math.max(tip, cxR + nein.r) + PAD;
        return {
          l, r, h: height, open,
          place(x, y) {
            region(x - l, y - PAD, l + r, height + PAD + (open ? 8 : PAD), s.id);
            box(x, y);
            port(x - tag, y + my, tr("ja"), "yes", s.id);
            port(x + tag, y + my, tr("nein"), "no", s.id);
            line([[x - tip, y + my], [x + cxL, y + my], [x + cxL, y + h]], { cls: "yes" });
            line([[x + tip, y + my], [x + cxR, y + my], [x + cxR, y + h]], { cls: "no" });
            ja.place(x + cxL, y + h);
            nein.place(x + cxR, y + h);
            if (ja.open) line([[x + cxL, y + h + ja.h], [x + cxL, y + height], [x, y + height]]);
            if (nein.open) line([[x + cxR, y + h + nein.h], [x + cxR, y + height], [x, y + height]]);
          },
        };
      }
      if (LOOPS.has(s.do)) {
        // the body below the header, an arrow from its end back up into the header, the way out on the right
        const body = seqLayout(s.body), forever = s.do === "forever", until = s.do === "repeat_until";
        const left = Math.max(hw, body.l) + LOOP_PAD;
        const right = forever ? Math.max(hw, body.r) : Math.max(tip + STUB, body.r + LOOP_PAD, until ? 20 + PORT_W : 0);
        const bodyEnd = h + body.h, back = body.open ? bodyEnd + BACK : bodyEnd;
        const height = forever ? back : back + BACK;
        return {
          l: left + PAD, r: right + PAD, h: height, open: !forever,
          place(x, y) {
            region(x - left - PAD, y - PAD, left + right + 2 * PAD, back + 2 * PAD, s.id);
            box(x, y);
            body.place(x, y + h);
            if (body.open) line([[x, y + bodyEnd], [x, y + back], [x - left, y + back], [x - left, y + my], [x - hw, y + my]], { arrow: true, cls: "loop" });
            if (!forever) {
              port(x + tag, y + my, until ? tr("ja") : tr("fertig"), "yes", s.id);
              line([[x + tip, y + my], [x + right, y + my], [x + right, y + height], [x, y + height]], { cls: until ? "yes" : "" });
            }
            if (until) port(x + 20 + PORT_W / 2, y + h + 4 + PORT_H / 2, tr("nein"), "no", s.id);
          },
        };
      }
      if (s.do === "wait_until") {
        // "nein": back into itself (ask again); "ja": on downwards
        const out = tip + STUB;
        return {
          l: out + PAD, r: Math.max(hw, 20 + PORT_W) + PAD, h, open: true,
          place(x, y) {
            box(x, y);
            port(x - tag, y + my, tr("nein"), "no", s.id);
            line([[x - tip, y + my], [x - out, y + my], [x - out, y - 16], [x - hw / 2, y - 16], [x - hw / 2, y]], { arrow: true, cls: "no" });
            port(x + 20 + PORT_W / 2, y + h + 4 + PORT_H / 2, tr("ja"), "yes", s.id);
          },
        };
      }
      return { l: hw, r: hw, h, open: s.do !== "end", place: box };
    }

    // 3. lay out and place everything
    const body = seqLayout(seq, true);
    const sw = start.offsetWidth, sh = start.offsetHeight, ew = stop.offsetWidth, eh = stop.offsetHeight;
    const l = Math.max(body.l, sw / 2, ew / 2), r = Math.max(body.r, sw / 2, ew / 2);
    const x = MARGIN + l;
    let y = MARGIN;
    pos(start, x - sw / 2, y);
    y += sh;
    body.place(x, y);
    y += body.h;
    if (body.open) { pos(stop, x - ew / 2, y); y += eh; } else stop.remove();
    const width = Math.ceil(l + r + 2 * MARGIN), height = Math.ceil(y + MARGIN);
    ui.stage.style.width = `${width}px`;
    ui.stage.style.height = `${height}px`;
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    applyScale();
    if (recenter) {
      recenter = false;
      ui.scroller.scrollTop = 0;
      ui.scroller.scrollLeft = Math.max(0, ui.sizer.offsetLeft + x * scale - ui.scroller.clientWidth / 2);
    }
    markCursor();
    applySelection();
    applyRunning();
    applyError();
  }

  // arrowheads: one per line colour (a marker can't take the colour of the line using it)
  function markerDefs() {
    return ["", "loop", "yes", "no"].map(cls => {
      const m = svgEl("marker", { id: `f-arrow${cls ? `-${cls}` : ""}`, viewBox: "0 0 10 10", refX: 8, refY: 5,
                                  markerWidth: 17, markerHeight: 17, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" });
      m.append(svgEl("path", { d: "M1.5 1.5 L9 5 L1.5 8.5 z", class: `f-arrowhead ${cls}` }));
      return m;
    });
  }

  // a picture of a statement with everything that belongs to it (lanes, body, arrows, tags), for dragging
  function structureGhost(s) {
    const b = boxes.get(s.id), ids = idsIn(s);
    const ghost = el("div", { class: "f-ghost f-ghost-group" });
    ghost.style.width = `${b.w}px`;
    ghost.style.height = `${b.h}px`;
    const pic = svgEl("svg", { width: b.w, height: b.h, viewBox: `${b.x} ${b.y} ${b.w} ${b.h}`, class: "f-svg" });
    ui.svg.querySelectorAll(".f-region").forEach(r => { if (ids.has(r.dataset.owner)) pic.append(r.cloneNode(true)); });
    const g = ui.svg.querySelector(`g[data-owner="${CSS.escape(s.id)}"]`);
    if (g) pic.append(g.cloneNode(true));
    ghost.append(pic);
    ui.layer.querySelectorAll(".f-node[data-id], .f-port").forEach(e => {
      if (!ids.has(e.dataset.id || e.dataset.owner)) return;
      const c = e.cloneNode(true);
      c.classList.remove("selected", "running", "error", "dragging");
      c.removeAttribute("data-id");
      c.style.left = `${e.offsetLeft - b.x}px`;
      c.style.top = `${e.offsetTop - b.y}px`;
      ghost.append(c);
    });
    return ghost;
  }

  function idsIn(s, out = new Set()) {
    out.add(s.id);
    bodiesOf(s).forEach(b => b.forEach(c => idsIn(c, out)));
    return out;
  }

  // dim a statement with everything that belongs to it (while it is being dragged)
  function dimStructure(s) {
    const ids = idsIn(s);
    ui.layer.querySelectorAll(".f-node[data-id], .f-port").forEach(e => { if (ids.has(e.dataset.id || e.dataset.owner)) e.classList.add("dragging"); });
    ui.svg.querySelectorAll(".f-region").forEach(r => { if (ids.has(r.dataset.owner)) r.classList.add("dragging"); });
    ui.svg.querySelector(`g[data-owner="${CSS.escape(s.id)}"]`)?.classList.add("dragging");
  }

  function nodeEl(s) {
    const def = DEFS[s.do];
    const e = el("div", { class: `f-node f-${def.shape || "box"}`, "data-id": s.id, style: `--c: ${COLORS[def.cat]}` }, ...content(s));
    e.addEventListener("pointerdown", ev => pressDraggable(ev, { kind: "move", id: s.id, label: e }));
    e.addEventListener("click", ev => {
      if (dragJustEnded() || ev.target.closest("input, select, button")) return;
      selected = selected === s.id ? null : s.id;
      applySelection();
    });
    return e;
  }

  function startEl() {
    if (view === null) return el("div", { class: "f-node f-pill f-start" }, el("span", { class: "f-t" }, tr("▶ Start")));
    const f = doc.functions[view], name = view;
    return el("div", { class: "f-node f-pill f-start f-fn", style: `--c: ${COLORS.mine}` },
      el("span", { class: "f-t" }, `🧩 ${name}`),
      f.params.length ? el("span", { class: "f-t f-small" }, tr("mit")) : null,
      f.params.map((p, i) => el("span", { class: "f-param" }, p,
        el("button", { type: "button", class: "f-x", "aria-label": tr("Eingabe „{name}“ entfernen", { name: p }), onclick: () => removeParam(name, i) }, "✕"))),
      el("button", { type: "button", class: "f-tool", title: tr("Eingabe hinzufügen (z. B. eine Strecke)"), onclick: () => addParam(name) }, tr("＋ Eingabe")),
      el("button", { type: "button", class: "f-tool", title: tr("Umbenennen"), "aria-label": tr("Block umbenennen"), onclick: () => renameFunction(name) }, "✎"),
      el("button", { type: "button", class: "f-tool", title: tr("Block löschen"), "aria-label": tr("Block löschen"), onclick: () => deleteFunction(name) }, "🗑"));
  }

  function endEl() {
    return el("div", { class: "f-node f-pill f-end" }, el("span", { class: "f-t" }, view === null ? tr("🏁 Ziel") : tr("↩ zurück")));
  }

  // --- states drawn on top of a render: cursor, selection, running box, error ---------------------------

  function markCursor() {
    for (const t of targets) t.btn.classList.toggle("cursor", !!cursor && t.arr === cursor.arr && t.index === cursor.index);
  }

  function applySelection() {
    if (!ui) return;
    ui.layer.querySelectorAll(".f-node.selected").forEach(e => e.classList.remove("selected"));
    ui.layer.querySelectorAll(".f-tools").forEach(e => e.remove());
    const e = selected && nodeById(selected);
    if (!e) { selected = null; return; }
    e.classList.add("selected");
    const tools = el("div", { class: "f-tools" },
      el("button", { type: "button", class: "f-tool", title: tr("Kopie dahinter einfügen"), onclick: () => duplicate(selected) }, tr("⧉ Kopie")),
      el("button", { type: "button", class: "f-tool del", title: tr("Löschen (Entf)"), onclick: () => remove(selected) }, tr("✕ Löschen")));
    tools.style.left = `${e.offsetLeft + e.offsetWidth + 8}px`;
    tools.style.top = `${e.offsetTop}px`;
    ui.layer.append(tools);
  }

  const nodeById = id => ui && ui.layer.querySelector(`.f-node[data-id="${CSS.escape(id)}"]`);

  // the robot's position: the innermost statement if it is on screen, else the call in the main program
  function applyRunning() {
    if (!ui) return;
    ui.layer.querySelectorAll(".f-node.running").forEach(e => e.classList.remove("running"));
    const e = (running.block && nodeById(running.block)) || (running.top && nodeById(running.top));
    if (e) e.classList.add("running");
  }

  function applyError() {
    if (!ui) return;
    ui.layer.querySelectorAll(".f-node.error").forEach(e => { e.classList.remove("error"); e.removeAttribute("title"); });
    const e = error.id && nodeById(error.id);
    if (e) { e.classList.add("error"); e.title = error.msg; }
    const where = error.id ? find(error.id) : null;
    ui.tabs.querySelectorAll(".f-tab").forEach(t => t.classList.toggle("error", !!where && t.dataset.view === (where.view ?? "")));
  }

  // --- tabs (main program, "Meine Blöcke") and palette ------------------------------------------------------

  function show(name) {
    view = name;
    recenter = true;
    cursor = null;
    selected = null;
    render();
  }

  function renderTabs() {
    const tab = (name, label) => el("button", {
      type: "button", class: "f-tab", "data-view": name ?? "", "aria-pressed": String(view === name),
      onclick: () => show(name),
    }, label);
    ui.tabs.replaceChildren(tab(null, tr("▶ Hauptprogramm")),
      ...Object.keys(doc.functions).map(name => tab(name, `🧩 ${name}`)),
      el("button", { type: "button", class: "f-tab f-new", title: tr("Einen eigenen Block bauen"), onclick: newFunction }, tr("＋ Neuer Block")),
      el("button", { type: "button", class: "f-tab f-undo", title: tr("Rückgängig (Strg+Z)"), disabled: !history.length, onclick: undo }, tr("↶ Rückgängig")));
  }

  function renderPalette() {
    const item = (label, cat, make, needsVar) => {
      const b = el("button", { type: "button", class: "f-pal-item", style: `--c: ${COLORS[cat]}`, title: tr("Antippen: am ausgewählten ＋ einfügen. Oder auf einen Pfeil ziehen.") }, label);
      b.addEventListener("click", () => { if (!dragJustEnded()) addFromPalette(make, needsVar); });
      b.addEventListener("pointerdown", e => pressDraggable(e, { kind: "new", make, needsVar, label: b, cat }));
      return b;
    };
    // a value block: dragged into a slot (tapping only explains)
    const value = (label, cat, make) => {
      const b = el("button", { type: "button", class: "f-pal-item f-pal-value", style: `--c: ${COLORS[cat]}`,
                               title: tr("Zieh den Wert in ein Feld oder auf eine Frage ⬡.") }, label);
      b.addEventListener("click", () => { if (!dragJustEnded()) toast(tr("Zieh den Wert in ein Feld oder auf eine Frage ⬡."), false); });
      b.addEventListener("pointerdown", e => pressDraggable(e, { kind: "value", make, label: b }));
      return b;
    };
    const section = (name, cat, ...kids) => el("section", { class: "f-pal-sec" },
      el("h3", { style: `--c: ${COLORS[cat]}` }, name), ...kids);
    const fns = Object.entries(doc.functions);
    const values = sec => [...(sec.values || []), ...(sec.cat === "vars" ? varsInView().map(name => [name, () => ({ k: "var", name })]) : [])];
    ui.palette.replaceChildren(
      ...PALETTE.map(sec => section(sec.name, sec.cat, sec.hint ? el("p", { class: "f-pal-hint" }, sec.hint) : null,
        values(sec).length ? el("div", { class: "f-pal-values" }, values(sec).map(([label, make]) => value(label, sec.cat, make))) : null,
        sec.items.map(([label, make, needs]) => item(label, sec.cat, make, needs === "var")),
        sec.cat === "vars" ? el("button", { type: "button", class: "f-pal-add", onclick: () => newVariable() }, tr("＋ Neue Variable")) : null)),
      section(tr("Meine Blöcke"), "mine",
        fns.map(([name, f]) => item(`🧩 ${name}`, "mine", () => ({ do: "call", name, args: f.params.map(() => num(0)) }))),
        el("button", { type: "button", class: "f-pal-add", onclick: newFunction }, tr("＋ Neuer Block"))));
  }

  // --- dragging (pointer events, so it works with fingers too) ---------------------------------------------

  let drag = null;
  let dragEndedAt = 0;
  const dragJustEnded = () => performance.now() - dragEndedAt < 300;

  function pressDraggable(e, payload) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (payload.kind === "move" && e.target.closest("input, select, button")) return;
    closePop();
    drag = { ...payload, x0: e.clientX, y0: e.clientY, pointer: e.pointerId, touch: e.pointerType !== "mouse", started: false };
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragUp);
    window.addEventListener("pointercancel", dragCancel);
  }

  function dragStart(e) {
    drag.started = true;
    let ghost;
    if (drag.kind === "move") {
      // the box lifts off with everything that belongs to it, right where it was
      const hit = find(drag.id), b = hit && boxes.get(drag.id);
      if (!b) { dragCancel(); return; }
      drag.stmt = hit.s;
      drag.inside = arraysIn(hit.s);
      ghost = structureGhost(hit.s);
      ghost.style.transform = `scale(${scale})`;
      const stage = ui.stage.getBoundingClientRect();
      drag.dx = drag.x0 - (stage.left + b.x * scale);
      drag.dy = drag.y0 - (stage.top + b.y * scale);
      dimStructure(hit.s);
    } else {
      ghost = drag.label.cloneNode(true);
      ghost.classList.add("f-ghost");
      drag.dx = Math.min(30, drag.label.offsetWidth / 2);
      drag.dy = 16;
    }
    document.body.append(ghost);
    drag.ghost = ghost;
    document.body.classList.add("f-dragging");
    if (drag.kind === "value") {
      document.body.classList.add("f-dragging-value");    // the value slots light up, the arrows stay as they are
      slots.forEach(s => s.el.classList.add("target"));
    } else {
      for (const t of targets) t.btn.classList.toggle("target", targetOk(t));
    }
    dragFollow(e);
  }

  function targetOk(t) {
    if (drag.kind !== "move") return true;
    return !drag.inside.has(t.arr);
  }

  function dragMove(e) {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!drag.started) {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.hypot(dx, dy) < DRAG_START) return;
      // a finger moving up or down the palette scrolls it (touch-action: pan-y) instead of dragging
      if (drag.kind !== "move" && drag.touch && Math.abs(dy) > Math.abs(dx)) { dragCancel(); return; }
      dragStart(e);
      if (!drag) return;
    }
    e.preventDefault();
    dragFollow(e);
  }

  function dragFollow(e) {
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.ghost.style.translate = `${e.clientX - drag.dx}px ${e.clientY - drag.dy}px`;
    if (drag.kind === "value") {
      // the slot under the pointer (with a little slack), else the nearest one close by
      let best = null, bestD = SLOT_RADIUS;
      for (const s of slots) {
        const r = s.el.getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bestD) { best = s; bestD = d; }
      }
      if (drag.hotSlot !== best) {
        drag.hotSlot?.el.classList.remove("hot");
        best?.el.classList.add("hot");
        drag.hotSlot = best;
      }
      if (!drag.scrolling) { drag.scrolling = true; requestAnimationFrame(autoScroll); }
      return;
    }
    let best = null, bestD = DROP_RADIUS;
    for (const t of targets) {
      if (!t.btn.classList.contains("target")) continue;
      const r = t.btn.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - e.clientX, r.top + r.height / 2 - e.clientY);
      if (d < bestD) { best = t; bestD = d; }
    }
    if (drag.hot !== best) {
      drag.hot?.btn.classList.remove("hot");
      best?.btn.classList.add("hot");
      drag.hot = best;
    }
    const p = ui.palette.getBoundingClientRect();
    drag.trash = drag.kind === "move" && !best && e.clientX >= p.left && e.clientX <= p.right && e.clientY >= p.top && e.clientY <= p.bottom;
    drag.ghost.classList.toggle("trash", drag.trash);
    ui.palette.classList.toggle("trash", drag.trash);
    if (!drag.scrolling) { drag.scrolling = true; requestAnimationFrame(autoScroll); }
  }

  // near the canvas edge while dragging: scroll that way
  function autoScroll() {
    if (!drag || !drag.started) return;
    const r = ui.scroller.getBoundingClientRect(), edge = 40, speed = 14;
    const inside = drag.x >= r.left && drag.x <= r.right && drag.y >= r.top && drag.y <= r.bottom;
    if (inside) {
      const sx = drag.x < r.left + edge ? -speed : drag.x > r.right - edge ? speed : 0;
      const sy = drag.y < r.top + edge ? -speed : drag.y > r.bottom - edge ? speed : 0;
      if (sx || sy) ui.scroller.scrollBy(sx, sy);
    }
    requestAnimationFrame(autoScroll);
  }

  function dragUp(e) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    dragCleanup();
    if (!d.started) return;              // a tap: the click handler does the rest
    dragEndedAt = performance.now();
    if (d.kind === "value") {
      if (d.hotSlot) putValue(d.hotSlot, d.make());
      return;
    }
    if (d.hot) {
      if (d.kind === "new") {
        if (d.needsVar && !varsInView().length && !newVariable()) return;
        insert(d.make(), d.hot.arr, d.hot.index);
      } else {
        move(d.id, d.hot.arr, d.hot.index);
      }
    } else if (d.trash) {
      remove(d.id);
    }
  }

  function dragCancel() { dragCleanup(); }

  function dragCleanup() {
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragUp);
    window.removeEventListener("pointercancel", dragCancel);
    if (drag && drag.started) {
      drag.ghost.remove();
      document.body.classList.remove("f-dragging", "f-dragging-value");
      slots.forEach(s => s.el.classList.remove("target", "hot"));
      ui.palette.classList.remove("trash");
      ui.root.querySelectorAll(".dragging").forEach(e => e.classList.remove("dragging"));
      for (const t of targets) t.btn.classList.remove("target", "hot");
    }
    drag = null;
  }

  // --- zoom and panning ------------------------------------------------------------------------------------

  function applyScale() {
    ui.stage.style.transform = `scale(${scale})`;
    ui.sizer.style.width = `${ui.stage.offsetWidth * scale}px`;
    ui.sizer.style.height = `${ui.stage.offsetHeight * scale}px`;
    ui.zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  }

  function setScale(next, cx, cy) {
    next = clamp(next, ZOOM.min, ZOOM.max);
    const sc = ui.scroller, r = sc.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    // keep the point under the pointer (or the middle) where it is
    const sizer = ui.sizer.getBoundingClientRect();
    const ux = (px - sizer.left) / scale, uy = (py - sizer.top) / scale;
    scale = next;
    applyScale();
    const after = ui.sizer.getBoundingClientRect();
    sc.scrollLeft += after.left + ux * scale - px;
    sc.scrollTop += after.top + uy * scale - py;
  }

  function setupPan() {
    const sc = ui.scroller;
    sc.addEventListener("wheel", e => {
      if (!e.ctrlKey) return;            // the wheel scrolls; Ctrl + wheel (or pinching a touchpad) zooms
      e.preventDefault();
      setScale(scale * (e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step), e.clientX, e.clientY);
    }, { passive: false });
    // the mouse drags the background around (fingers scroll it by themselves)
    sc.addEventListener("pointerdown", e => {
      if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest(".f-node, .f-plus, .f-tools, .f-zoom")) return;
      const x0 = e.clientX, y0 = e.clientY, l0 = sc.scrollLeft, t0 = sc.scrollTop;
      let moved = false;
      const mv = ev => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        moved = true;
        sc.classList.add("panning");
        sc.scrollLeft = l0 - (ev.clientX - x0);
        sc.scrollTop = t0 - (ev.clientY - y0);
      };
      const up = () => {
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
        sc.classList.remove("panning");
        if (!moved && selected) { selected = null; applySelection(); }
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
    sc.addEventListener("click", e => {    // a tap on the empty background (touch) unselects
      if (!e.target.closest(".f-node, .f-plus, .f-tools") && selected) { selected = null; applySelection(); }
    });
  }

  // --- public ----------------------------------------------------------------------------------------------

  function init(root) {
    if (ui) return;
    const zoomLabel = el("span", { class: "f-zoom-label" }, "100 %");
    const zoom = el("div", { class: "f-zoom" },
      el("button", { type: "button", "aria-label": tr("kleiner"), onclick: () => setScale(scale / ZOOM.step) }, "−"), zoomLabel,
      el("button", { type: "button", "aria-label": tr("größer"), onclick: () => setScale(scale * ZOOM.step) }, "+"));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "f-svg");
    const layer = el("div", { class: "f-layer" });
    const stage = el("div", { class: "f-stage" }, svg, layer);
    const sizer = el("div", { class: "f-sizer" }, stage);
    const scroller = el("div", { class: "f-scroller" }, sizer);
    const palette = el("div", { class: "f-palette", "aria-label": tr("Bausteine") });
    const tabs = el("div", { class: "f-tabs", role: "group", "aria-label": tr("Programm oder eigener Block") });
    const note = el("div", { class: "f-toast", role: "status", hidden: true });
    root.replaceChildren(el("div", { class: "f-main" }, palette, el("div", { class: "f-canvas" }, tabs, el("div", { class: "f-view" }, scroller, zoom, note))));
    ui = { root, svg, layer, stage, sizer, scroller, palette, tabs, zoomLabel, toast: note };
    setupPan();
    document.addEventListener("keydown", e => {
      if (!ui.root.offsetParent || document.querySelector("dialog[open]")) return;
      if (e.target instanceof Element && e.target.closest("input, select, textarea")) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (!selected) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(selected); }
      if (e.key === "Escape") { selected = null; applySelection(); }
    });
    new ResizeObserver(() => { if (dirty && ui.root.offsetParent) render(); }).observe(root);
    try { doc = cleanDoc(JSON.parse(localStorage.getItem(STORE_KEY) || "null")); } catch (_) { doc = emptyDoc(); }
    now = JSON.stringify(doc);
    render();
  }

  // a new document (a loaded program, the other view's program, "Neu"): ↶ starts afresh
  function load(saved) {
    history = [];
    now = null;
    hideToast();
    doc = cleanDoc(saved);
    view = null;
    recenter = true;
    cursor = null;
    selected = null;
    error = { id: null, msg: "" };
    changed();
  }

  function reset() { load(emptyDoc()); }

  return {
    init, load, reset, toAst, draftAst, exportAst, loadAst,
    state: () => JSON.parse(JSON.stringify(doc)),
    show: () => { if (ui && (dirty || ui.root.offsetParent)) render(); },
    highlight(block, top) { running = { block: block || null, top: top || null }; applyRunning(); },
    markError(id, msg) { error = { id: id || null, msg: msg || "" }; applyError(); },
    onChange: fn => { changeHandler = fn; },
    ready: () => !!ui,
  };
})();
