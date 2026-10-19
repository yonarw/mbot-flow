"use strict";

// Profi mode's "Blöcke" view: Scratch-like blocks (Blockly with its Scratch-style "zelos" renderer).
// The workspace is turned into the compiler's syntax tree (see server/compiler.py) by toAst(), and built from one
// by loadAst() – so the "Ablauf" view (flow.js) can show the same program.
// Loaded on demand by app.js, after vendor/blockly/*.

window.Advanced = (() => {
  const COLORS = {
    move: "#4C97FF", sound: "#CF63CF", sensor: "#5CB1D6", control: "#FFAB19", math: "#59C059", vars: "#FF8C1A",
    mine: "#FF6680",
  };
  const STORE_KEY = "mbot-advanced-v1";
  const PALETTE_SCALE = 0.8;

  const num = (name, value) => ({ [name]: { shadow: { type: "math_number", fields: { NUM: value } } } });
  const stmt = { previousStatement: null, nextStatement: null };

  const BLOCKS = [
    // --- Bewegung
    { type: "mbot_move", message0: "fahre %1 %2 Schritte", ...stmt, colour: COLORS.move,
      args0: [{ type: "field_dropdown", name: "DIR", options: [["vorwärts", "forward"], ["rückwärts", "backward"]] },
              { type: "field_number", name: "STEPS", value: 1, min: 0.1, max: 50 }],
      tooltip: "Fährt eine feste Strecke (Schritte aus der Kalibrierung) und hält dann an." },
    { type: "mbot_turn", message0: "drehe %1 um %2 °", ...stmt, colour: COLORS.move,
      args0: [{ type: "field_dropdown", name: "DIR", options: [["links", "left"], ["rechts", "right"]] },
              { type: "field_number", name: "DEG", value: 90, min: 5, max: 720 }],
      tooltip: "Dreht sich auf der Stelle (Winkel aus der Kalibrierung) und hält dann an." },
    { type: "mbot_drive", message0: "fahre %1 mit %2 %%", ...stmt, colour: COLORS.move, inputsInline: true,
      args0: [{ type: "field_dropdown", name: "DIR", options: [["vorwärts", "forward"], ["rückwärts", "backward"],
                                                                ["links herum", "left"], ["rechts herum", "right"]] },
              { type: "input_value", name: "POWER", check: "Number" }],
      tooltip: "Losfahren und weiterfahren, bis ein anderer Baustein etwas anderes sagt (z. B. „halte an“)." },
    { type: "mbot_motors", message0: "Motoren: links %1 %% rechts %2 %%", ...stmt, colour: COLORS.move, inputsInline: true,
      args0: [{ type: "input_value", name: "LEFT", check: "Number" }, { type: "input_value", name: "RIGHT", check: "Number" }],
      tooltip: "Jedes Rad einzeln: -100 (rückwärts) bis 100 (vorwärts). Unter ca. 30 drehen die Räder nicht." },
    { type: "mbot_stop", message0: "halte an", ...stmt, colour: COLORS.move, tooltip: "Beide Motoren aus." },
    // --- Klang
    { type: "mbot_beep", message0: "spiele Ton %1 Hz für %2 Sek.", ...stmt, colour: COLORS.sound, inputsInline: true,
      args0: [{ type: "input_value", name: "HZ", check: "Number" }, { type: "input_value", name: "SEC", check: "Number" }],
      tooltip: "Spielt den Ton und wartet, bis er fertig ist." },
    { type: "mbot_beep_start", message0: "starte Ton %1 Hz für %2 Sek.", ...stmt, colour: COLORS.sound, inputsInline: true,
      args0: [{ type: "input_value", name: "HZ", check: "Number" }, { type: "input_value", name: "SEC", check: "Number" }],
      tooltip: "Der Ton läuft, während das Programm schon weitermacht – z. B. beim Fahren." },
    // --- Sensoren
    { type: "mbot_distance", message0: "Abstand (cm)", output: "Number", colour: COLORS.sensor,
      tooltip: "Ultraschall-Sensor: 1 bis 400 cm. 400 heißt: nichts in Reichweite." },
    { type: "mbot_line", message0: "Linie %1 schwarz?", output: "Boolean", colour: COLORS.sensor,
      args0: [{ type: "field_dropdown", name: "SIDE", options: [["links", "left"], ["rechts", "right"]] }],
      tooltip: "Linienfolger-Sensor: ist unter dem linken / rechten Auge die schwarze Linie?" },
    { type: "mbot_light", message0: "Helligkeit", output: "Number", colour: COLORS.sensor,
      tooltip: "Lichtsensor auf der Platine: 0 (dunkel) bis 1023 (hell)." },
    { type: "mbot_button", message0: "Taste gedrückt?", output: "Boolean", colour: COLORS.sensor,
      tooltip: "Der kleine Knopf auf der Platine." },
    { type: "mbot_timer", message0: "Stoppuhr (ms)", output: "Number", colour: COLORS.sensor,
      tooltip: "Millisekunden seit dem Start (oder seit „Stoppuhr auf 0“). 1000 ms = 1 Sekunde." },
    { type: "mbot_timer_reset", message0: "Stoppuhr auf 0", ...stmt, colour: COLORS.sensor },
    // --- Steuerung
    { type: "mbot_start", message0: "Wenn ▶ Start geklickt", nextStatement: null, colour: COLORS.control,
      extensions: ["mbot_hat"], tooltip: "Hier fängt das Programm an. Nur was hier dranhängt, läuft auf dem Roboter." },
    { type: "mbot_wait", message0: "warte %1 Sek.", ...stmt, colour: COLORS.control, inputsInline: true,
      args0: [{ type: "input_value", name: "SEC", check: "Number" }] },
    { type: "mbot_repeat", message0: "wiederhole %1 mal %2 %3", ...stmt, colour: COLORS.control,
      args0: [{ type: "input_value", name: "TIMES", check: "Number" }, { type: "input_dummy" },
              { type: "input_statement", name: "DO" }] },
    { type: "mbot_forever", message0: "wiederhole fortlaufend %1 %2", previousStatement: null, colour: COLORS.control,
      args0: [{ type: "input_dummy" }, { type: "input_statement", name: "DO" }] },
    { type: "mbot_if", message0: "falls %1 dann %2 %3", ...stmt, colour: COLORS.control,
      args0: [{ type: "input_value", name: "COND", check: "Boolean" }, { type: "input_dummy" },
              { type: "input_statement", name: "THEN" }] },
    { type: "mbot_if_else", message0: "falls %1 dann %2 %3", message1: "sonst %1 %2", ...stmt, colour: COLORS.control,
      args0: [{ type: "input_value", name: "COND", check: "Boolean" }, { type: "input_dummy" },
              { type: "input_statement", name: "THEN" }],
      args1: [{ type: "input_dummy" }, { type: "input_statement", name: "ELSE" }] },
    { type: "mbot_wait_until", message0: "warte bis %1", ...stmt, colour: COLORS.control,
      args0: [{ type: "input_value", name: "COND", check: "Boolean" }] },
    { type: "mbot_repeat_until", message0: "wiederhole bis %1 %2 %3", ...stmt, colour: COLORS.control,
      args0: [{ type: "input_value", name: "COND", check: "Boolean" }, { type: "input_dummy" },
              { type: "input_statement", name: "DO" }] },
    { type: "mbot_end", message0: "beende Programm", previousStatement: null, colour: COLORS.control },
    // --- Rechnen
    { type: "mbot_arith", message0: "%1 %2 %3", output: "Number", colour: COLORS.math, inputsInline: true,
      args0: [{ type: "input_value", name: "A", check: "Number" },
              { type: "field_dropdown", name: "FN", options: [["+", "+"], ["−", "-"], ["×", "*"], ["÷", "/"], ["Rest", "%"]] },
              { type: "input_value", name: "B", check: "Number" }],
      tooltip: "Der Roboter rechnet mit ganzen Zahlen: 7 ÷ 2 = 3." },
    { type: "mbot_compare", message0: "%1 %2 %3", output: "Boolean", colour: COLORS.math, inputsInline: true,
      args0: [{ type: "input_value", name: "A", check: "Number" },
              { type: "field_dropdown", name: "FN", options: [["<", "<"], [">", ">"], ["=", "="], ["≤", "<="], ["≥", ">="], ["≠", "!="]] },
              { type: "input_value", name: "B", check: "Number" }] },
    { type: "mbot_logic", message0: "%1 %2 %3", output: "Boolean", colour: COLORS.math, inputsInline: true,
      args0: [{ type: "input_value", name: "A", check: "Boolean" },
              { type: "field_dropdown", name: "FN", options: [["und", "and"], ["oder", "or"]] },
              { type: "input_value", name: "B", check: "Boolean" }] },
    { type: "mbot_not", message0: "nicht %1", output: "Boolean", colour: COLORS.math,
      args0: [{ type: "input_value", name: "A", check: "Boolean" }] },
    { type: "mbot_random", message0: "Zufallszahl von %1 bis %2", output: "Number", colour: COLORS.math, inputsInline: true,
      args0: [{ type: "input_value", name: "LO", check: "Number" }, { type: "input_value", name: "HI", check: "Number" }] },
  ];

  const b = (type, inputs) => ({ kind: "block", type, ...(inputs ? { inputs } : {}) });
  const TOOLBOX = {
    kind: "categoryToolbox",
    contents: [
      { kind: "category", name: "Bewegung", colour: COLORS.move, contents: [
        b("mbot_move"), b("mbot_turn"), b("mbot_drive", num("POWER", 50)),
        b("mbot_motors", { ...num("LEFT", 50), ...num("RIGHT", 50) }), b("mbot_stop")] },
      { kind: "category", name: "Klang", colour: COLORS.sound, contents: [
        b("mbot_beep", { ...num("HZ", 880), ...num("SEC", 0.25) }), b("mbot_beep_start", { ...num("HZ", 440), ...num("SEC", 0.5) })] },
      { kind: "category", name: "Sensoren", colour: COLORS.sensor, contents: [
        b("mbot_distance"), b("mbot_line"), b("mbot_light"), b("mbot_button"), b("mbot_timer"), b("mbot_timer_reset")] },
      { kind: "category", name: "Steuerung", colour: COLORS.control, contents: [
        b("mbot_start"), b("mbot_wait", num("SEC", 1)), b("mbot_repeat", num("TIMES", 4)), b("mbot_forever"),
        b("mbot_if"), b("mbot_if_else"), b("mbot_wait_until"), b("mbot_repeat_until"), b("mbot_end")] },
      { kind: "category", name: "Rechnen", colour: COLORS.math, contents: [
        b("mbot_arith", { ...num("A", 0), ...num("B", 0) }), b("mbot_compare", { ...num("A", 0), ...num("B", 50) }),
        b("mbot_logic"), b("mbot_not"), b("mbot_random", { ...num("LO", 1), ...num("HI", 10) }), b("math_number")] },
      { kind: "category", name: "Variablen", colour: COLORS.vars, custom: "VARIABLE" },
      { kind: "category", name: "Meine Blöcke", colour: COLORS.mine, custom: "MBOT_FUNCS" },
    ],
  };

  let ws = null;
  let running = null;          // block id highlighted as running
  let changeHandler = () => {};

  function theme() {
    const dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    return Blockly.Theme.defineTheme(dark ? "mbot-dark" : "mbot-light", {
      base: Blockly.Themes.Classic,
      componentStyles: dark ? {
        workspaceBackgroundColour: "#12161f", toolboxBackgroundColour: "#1c2230", toolboxForegroundColour: "#eef1f8",
        flyoutBackgroundColour: "#252c3c", flyoutForegroundColour: "#eef1f8", flyoutOpacity: 0.95,
        scrollbarColour: "#a4adc0", scrollbarOpacity: 0.4, insertionMarkerColour: "#ffffff", insertionMarkerOpacity: 0.3,
        cursorColour: "#eef1f8",
      } : {
        workspaceBackgroundColour: "#f9fafd", toolboxBackgroundColour: "#ffffff", toolboxForegroundColour: "#1d2433",
        flyoutBackgroundColour: "#eef1f8", flyoutOpacity: 0.95,
      },
      fontStyle: { family: "system-ui, 'Segoe UI', Roboto, sans-serif", weight: "600", size: 12 },
      blockStyles: {                    // same colours as their categories
        procedure_blocks: { colourPrimary: COLORS.mine, colourSecondary: "#FF4D6A", colourTertiary: "#E64D6A" },
        variable_blocks: { colourPrimary: COLORS.vars, colourSecondary: "#FFA54C", colourTertiary: "#DB6E00" },
      },
    });
  }

  function init(container) {
    if (ws) return;
    Blockly.Extensions.register("mbot_hat", function () { this.hat = "cap"; });
    Object.assign(Blockly.Msg, {        // Blockly's German reads "um etwas tun"; say it the way Scratch does
      PROCEDURES_DEFNORETURN_TITLE: "Definiere", PROCEDURES_DEFNORETURN_PROCEDURE: "mein Block",
      PROCEDURES_BEFORE_PARAMS: "mit:", PROCEDURES_MUTATORCONTAINER_TITLE: "Eingaben", PROCEDURES_MUTATORARG_TITLE: "Eingabe:",
    });
    Blockly.defineBlocksWithJsonArray(BLOCKS);
    registerContinuousToolbox();       // vendor/blockly/continuous-toolbox.js: the palette stays open, like Scratch
    // ... and keeps its size when the program is zoomed (Blockly scales it along by default)
    class PaletteFlyout extends ContinuousFlyout {
      getFlyoutScale() { return PALETTE_SCALE; }
    }
    Blockly.registry.register(Blockly.registry.Type.FLYOUTS_VERTICAL_TOOLBOX, "MbotPalette", PaletteFlyout);
    ws = Blockly.inject(container, {
      // without "Meine Blöcke" first: the always-open palette fills every category at once, and that one's
      // contents come from a callback that can only be registered on the workspace (see below)
      toolbox: { ...TOOLBOX, contents: TOOLBOX.contents.filter(c => c.custom !== "MBOT_FUNCS") }, renderer: "zelos", theme: theme(), media: "vendor/blockly/media/",
      plugins: { flyoutsVerticalToolbox: "MbotPalette", metricsManager: "ContinuousMetrics", toolbox: "ContinuousToolbox" },
      trashcan: true, sounds: false,
      // like Scratch: the wheel scrolls, Ctrl + wheel (or pinching a touchpad) zooms
      zoom: { controls: true, wheel: true, pinch: true, startScale: 0.9, scaleSpeed: 1.05, minScale: 0.4, maxScale: 2 },
      move: { scrollbars: true, drag: true, wheel: true },
      grid: { spacing: 40, length: 2, colour: "#8883", snap: false },
    });
    new ResizeObserver(() => Blockly.svgResize(ws)).observe(container);   // the page layout decides the size
    // "Meine Blöcke": a new definition, then a call block for every block defined so far (Blockly's own
    // procedure blocks; the ones with a return value are left out)
    ws.registerToolboxCategoryCallback("MBOT_FUNCS", w => [
      { kind: "label", text: "Neuen Block bauen (Eingaben übers Zahnrad):" },
      { kind: "block", type: "procedures_defnoreturn" },
      ...Blockly.Procedures.allProcedures(w)[0].map(([name, params]) =>
        ({ kind: "block", type: "procedures_callnoreturn", extraState: { name, params } })),
    ]);
    ws.updateToolbox(TOOLBOX);
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) { Blockly.serialization.workspaces.load(saved, ws); restored = true; }
    } catch (_) { /* broken or no storage: start fresh */ }
    if (!restored || !ws.getTopBlocks(false).length) reset();
    let timer = null;
    ws.addChangeListener(e => {
      if (e.isUiEvent) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state())); } catch (_) { /* ignore */ }
        changeHandler();
      }, 250);
    });
  }

  function reset() {
    ws.clear();
    const start = ws.newBlock("mbot_start");
    start.initSvg();
    start.render();
    start.moveBy(40, 40);
  }

  const state = () => Blockly.serialization.workspaces.save(ws);
  function load(saved) {
    Blockly.serialization.workspaces.load(saved, ws);
    if (!ws.getTopBlocks(false).length) reset();
  }

  // --- workspace -> syntax tree -------------------------------------------------------------

  const varName = (blk, field = "VAR") => {
    const v = blk.getField(field).getVariable();
    return v.getName ? v.getName() : v.name;
  };

  function expr(blk) {
    if (!blk || !blk.isEnabled()) return null;        // empty input: the compiler explains
    const input = name => expr(blk.getInputTargetBlock(name));
    switch (blk.type) {
      case "math_number": return { op: "num", value: Number(blk.getFieldValue("NUM")) };
      case "variables_get": return { op: "var", name: varName(blk) };
      case "mbot_distance": return { op: "sensor", name: "distance" };
      case "mbot_light": return { op: "sensor", name: "light" };
      case "mbot_button": return { op: "sensor", name: "button" };
      case "mbot_timer": return { op: "sensor", name: "timer" };
      case "mbot_line": return { op: "sensor", name: blk.getFieldValue("SIDE") === "left" ? "line_left" : "line_right" };
      case "mbot_arith": case "mbot_compare": case "mbot_logic":
        return { op: "bin", fn: blk.getFieldValue("FN"), a: input("A"), b: input("B") };
      case "mbot_not": return { op: "not", a: input("A") };
      case "mbot_random": return { op: "random", lo: input("LO"), hi: input("HI") };
      default: return { op: blk.type };              // unknown: the compiler names it
    }
  }

  function stmts(blk) {
    const out = [];
    for (; blk; blk = blk.getNextBlock()) {
      if (!blk.isEnabled()) continue;
      const s = statement(blk);
      if (s) out.push({ id: blk.id, ...s });
    }
    return out;
  }

  function statement(blk) {
    const input = name => expr(blk.getInputTargetBlock(name));
    const body = name => stmts(blk.getInputTargetBlock(name));
    switch (blk.type) {
      case "mbot_move": return { do: "move", dir: blk.getFieldValue("DIR"), steps: Number(blk.getFieldValue("STEPS")) };
      case "mbot_turn": return { do: "turn", dir: blk.getFieldValue("DIR"), deg: Number(blk.getFieldValue("DEG")) };
      case "mbot_drive": return { do: "drive", dir: blk.getFieldValue("DIR"), power: input("POWER") };
      case "mbot_motors": return { do: "motors", left: input("LEFT"), right: input("RIGHT") };
      case "mbot_stop": return { do: "stop" };
      case "mbot_beep": return { do: "beep", hz: input("HZ"), sec: input("SEC"), wait: true };
      case "mbot_beep_start": return { do: "beep", hz: input("HZ"), sec: input("SEC"), wait: false };
      case "mbot_timer_reset": return { do: "reset_timer" };
      case "mbot_wait": return { do: "wait", sec: input("SEC") };
      case "mbot_repeat": return { do: "repeat", times: input("TIMES"), body: body("DO") };
      case "mbot_forever": return { do: "forever", body: body("DO") };
      case "mbot_if": return { do: "if", cond: input("COND"), then: body("THEN") };
      case "mbot_if_else": return { do: "if", cond: input("COND"), then: body("THEN"), else: body("ELSE") };
      case "mbot_wait_until": return { do: "wait_until", cond: input("COND") };
      case "mbot_repeat_until": return { do: "repeat_until", cond: input("COND"), body: body("DO") };
      case "mbot_end": return { do: "end" };
      case "variables_set": return { do: "set", var: varName(blk), value: input("VALUE") };
      case "math_change": return { do: "change", var: varName(blk), by: input("DELTA") };
      case "procedures_callnoreturn":
        return { do: "call", name: blk.getProcedureCall(), args: blk.getVars().map((_, i) => input(`ARG${i}`)) };
      default: return { do: blk.type };
    }
  }

  // Only the stack under "Wenn ▶ Start geklickt" runs (the first one, if there are several).
  function toAst() {
    const hat = ws.getTopBlocks(true).find(blk => blk.type === "mbot_start" && blk.isEnabled());
    if (!hat) throw new Error("Es fehlt der Baustein „Wenn ▶ Start geklickt“ (unter Steuerung).");
    const body = stmts(hat.getNextBlock());
    if (!body.length) throw new Error("Häng Bausteine unter „Wenn ▶ Start geklickt“.");
    return { body, functions: functions() };
  }

  // "Meine Blöcke": every enabled definition; the compiler only includes the ones that are used
  function functions() {
    const out = {};
    for (const def of ws.getTopBlocks(false)) {
      if (def.type !== "procedures_defnoreturn" || !def.isEnabled()) continue;
      out[def.getFieldValue("NAME")] = { id: def.id, params: def.getVars(), body: stmts(def.getInputTargetBlock("STACK")) };
    }
    return out;
  }

  // the warning sign on the block a compile error is about (one at a time)
  let warned = null;
  function markError(id, message) {
    const old = warned && ws && ws.getBlockById(warned);
    if (old) old.setWarningText(null);
    warned = null;
    const blk = id && ws && ws.getBlockById(id);
    if (blk) {
      blk.setWarningText(message);
      warned = id;
    }
  }

  // like toAst(), but never throws: for saving unfinished programs
  function draftAst() {
    try { return toAst(); } catch (_) { return { body: [] }; }
  }

  // the whole program for the other view, also when it is unfinished; `loose`: how many stacks are not under
  // "Wenn ▶ Start geklickt" (they never run, and the other view has no place for them)
  function exportAst() {
    const hat = ws.getTopBlocks(true).find(blk => blk.type === "mbot_start" && blk.isEnabled());
    const defs = ws.getTopBlocks(false).filter(blk => blk.type === "procedures_defnoreturn");
    const params = new Set(defs.flatMap(d => d.getVars()));
    const vars = ws.getVariableMap().getAllVariables().map(v => v.getName()).filter(n => !params.has(n));
    const loose = ws.getTopBlocks(false).filter(blk => blk !== hat && blk.type !== "procedures_defnoreturn").length;
    return { ast: { body: hat ? stmts(hat.getNextBlock()) : [], functions: functions() }, vars, loose };
  }

  // --- syntax tree -> workspace ---------------------------------------------------------------------
  // Statement blocks keep the statements' ids (so the running block and errors still find them); Blockly arranges
  // the stacks (cleanUp).

  const SENSOR_BLOCKS = {
    distance: { type: "mbot_distance" }, light: { type: "mbot_light" }, button: { type: "mbot_button" },
    timer: { type: "mbot_timer" }, line_left: { type: "mbot_line", fields: { SIDE: "left" } },
    line_right: { type: "mbot_line", fields: { SIDE: "right" } },
  };
  const ARITH = new Set(["+", "-", "*", "/", "%"]), COMPARE = new Set(["<", ">", "=", "<=", ">=", "!="]);

  function loadAst(ast, vars = []) {
    const used = new Set(vars);
    const varId = name => { used.add(name); return `v:${name}`; };
    const numBlock = n => ({ type: "math_number", fields: { NUM: Number(n) || 0 } });
    const clean = obj => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (v) out[k] = v;
      return Object.keys(out).length ? out : undefined;
    };
    // a number slot: a number is its shadow, anything else a block over a 0 shadow; null stays empty
    const numIn = e => {
      if (e == null) return undefined;
      if (typeof e === "number" || e.op === "num") return { shadow: numBlock(typeof e === "number" ? e : e.value) };
      const block = exprBlock(e);
      return block ? { shadow: numBlock(0), block } : undefined;
    };
    const boolIn = e => {
      const block = e == null ? null : exprBlock(e);
      return block ? { block } : undefined;
    };
    function exprBlock(e) {
      if (typeof e === "number") return numBlock(e);
      switch (e && e.op) {
        case "num": return numBlock(e.value);
        case "var": return { type: "variables_get", fields: { VAR: { id: varId(e.name) } } };
        case "sensor": return SENSOR_BLOCKS[e.name] ? { ...SENSOR_BLOCKS[e.name] } : null;
        case "not": return { type: "mbot_not", inputs: clean({ A: boolIn(e.a) }) };
        case "neg": return { type: "mbot_arith", fields: { FN: "-" }, inputs: clean({ A: numIn(0), B: numIn(e.a) }) };
        case "random": return { type: "mbot_random", inputs: clean({ LO: numIn(e.lo), HI: numIn(e.hi) }) };
        case "bin":
          if (ARITH.has(e.fn)) return { type: "mbot_arith", fields: { FN: e.fn }, inputs: clean({ A: numIn(e.a), B: numIn(e.b) }) };
          if (COMPARE.has(e.fn)) return { type: "mbot_compare", fields: { FN: e.fn }, inputs: clean({ A: numIn(e.a), B: numIn(e.b) }) };
          return { type: "mbot_logic", fields: { FN: e.fn === "or" ? "or" : "and" }, inputs: clean({ A: boolIn(e.a), B: boolIn(e.b) }) };
        default: return null;
      }
    }
    const params = name => ((ast.functions || {})[name] || {}).params || [];
    function stmtBlock(s) {
      const b = (type, parts = {}) => ({ type, id: s.id, ...parts });
      const body = arr => { const first = chain(arr); return first ? { block: first } : undefined; };
      switch (s.do) {
        case "move": return b("mbot_move", { fields: { DIR: s.dir, STEPS: s.steps } });
        case "turn": return b("mbot_turn", { fields: { DIR: s.dir, DEG: s.deg } });
        case "drive": return b("mbot_drive", { fields: { DIR: s.dir }, inputs: clean({ POWER: numIn(s.power) }) });
        case "motors": return b("mbot_motors", { inputs: clean({ LEFT: numIn(s.left), RIGHT: numIn(s.right) }) });
        case "stop": return b("mbot_stop");
        case "beep": return b(s.wait === false ? "mbot_beep_start" : "mbot_beep", { inputs: clean({ HZ: numIn(s.hz), SEC: numIn(s.sec) }) });
        case "reset_timer": return b("mbot_timer_reset");
        case "wait": return b("mbot_wait", { inputs: clean({ SEC: numIn(s.sec) }) });
        case "repeat": return b("mbot_repeat", { inputs: clean({ TIMES: numIn(s.times), DO: body(s.body) }) });
        case "forever": return b("mbot_forever", { inputs: clean({ DO: body(s.body) }) });
        case "if":
          return s.else && s.else.length
            ? b("mbot_if_else", { inputs: clean({ COND: boolIn(s.cond), THEN: body(s.then), ELSE: body(s.else) }) })
            : b("mbot_if", { inputs: clean({ COND: boolIn(s.cond), THEN: body(s.then) }) });
        case "wait_until": return b("mbot_wait_until", { inputs: clean({ COND: boolIn(s.cond) }) });
        case "repeat_until": return b("mbot_repeat_until", { inputs: clean({ COND: boolIn(s.cond), DO: body(s.body) }) });
        case "end": return b("mbot_end");
        case "set": return b("variables_set", { fields: { VAR: { id: varId(s.var || "Variable") } }, inputs: clean({ VALUE: numIn(s.value) }) });
        case "change": return b("math_change", { fields: { VAR: { id: varId(s.var || "Variable") } }, inputs: clean({ DELTA: numIn(s.by) }) });
        case "call": return b("procedures_callnoreturn", {
          extraState: { name: s.name, params: params(s.name) },
          inputs: clean(Object.fromEntries((s.args || []).map((a, i) => [`ARG${i}`, numIn(a)]))) });
        default: return null;
      }
    }
    function chain(arr) {
      let first = null, last = null;
      for (const s of arr || []) {
        const blk = stmtBlock(s);
        if (!blk) continue;
        if (last) last.next = { block: blk }; else first = blk;
        last = blk;
        if (s.do === "forever" || s.do === "end") break;     // these blocks have nothing below them
      }
      return first;
    }
    // definitions first: a call loaded before its definition would make Blockly create one
    const top = Object.entries(ast.functions || {}).map(([name, f], i) => ({
      type: "procedures_defnoreturn", id: f.id, x: 0, y: i + 1, fields: { NAME: name },
      extraState: (f.params || []).length ? { params: f.params.map(p => ({ name: p, id: varId(p) })) } : undefined,
      inputs: clean({ STACK: (() => { const first = chain(f.body); return first ? { block: first } : null; })() }),
    }));
    const first = chain(ast.body);
    top.push({ type: "mbot_start", x: 0, y: 0, ...(first ? { next: { block: first } } : {}) });
    ws.clear();
    Blockly.serialization.workspaces.load({
      blocks: { languageVersion: 0, blocks: top },
      variables: [...used].map(name => ({ name, id: `v:${name}` })),
    }, ws);
    ws.cleanUp();
    ws.scrollCenter();
  }

  // --- live view ---------------------------------------------------------------------------

  // An arrow right of the block the robot is in. It lives on the workspace canvas, so it scrolls and zooms with
  // the blocks; it slides from block to block (CSS transition) instead of re-outlining block shapes.
  let pointer = null;
  const ROW = 48;                   // height of a block's first row (zelos renderer), in workspace units

  function highlight(id) {
    if (!ws) return;
    const blk = id && ws.getBlockById(id);
    if (!blk || !blk.rendered) {
      if (pointer) pointer.style.display = "none";
      running = null;
      return;
    }
    const canvas = ws.getCanvas();
    if (!pointer) {
      pointer = Blockly.utils.dom.createSvgElement("path", { class: "mbot-pointer", d: "M0 0 L20 -15 L20 -6 L42 -6 L42 6 L20 6 L20 15 Z" }, canvas);
    } else if (canvas.lastChild !== pointer) {
      canvas.appendChild(pointer);  // stay above blocks added since
    }
    const xy = blk.getRelativeToSurfaceXY();
    const jump = running === null;  // appearing: no slide in from wherever it was last time
    pointer.style.transition = jump ? "none" : "";
    pointer.style.transform = `translate(${xy.x + blk.width + 10}px, ${xy.y + Math.min(blk.height, ROW) / 2}px)`;
    pointer.style.display = "";
    running = id;
  }

  return {
    init, state, load, toAst, draftAst, exportAst, loadAst, highlight, markError, reset: () => ws && reset(),
    resize: () => { if (ws) { Blockly.svgResize(ws); ws.render(); } },    // render: it may have been loaded while hidden
    onChange: fn => { changeHandler = fn; },
    ready: () => !!ws,
  };
})();
