"""Block programs -> mbot_vm bytecode.

Input is a small JSON syntax tree that every GUI mode produces (the simple list of blocks is turned into one
by mbot_server.blocks_to_ast, flowcharts by web/flow.js, Blockly workspaces by web/advanced.js). Every statement has an "id"; the
compiler records which instructions belong to which statement, so the robot's program counter tells the
GUI which block to highlight.

    {"body": [stmt, ...], "functions": {name: {"params": [name, ...], "body": [stmt, ...], "id": ...}}}

Functions (saved programs used as blocks, Profi "Meine Blöcke") are compiled once and called with CALL/RET;
parameters are hidden variables the call sets (no recursion, so every function needs only one set). Recursion
and too deep nesting are compile errors. A CompileError names the block it is about (.block), so the GUI can
mark it.

Statements ("do" key):
    move        dir forward|backward, steps        calibrated "Schritte" (timed)
    turn        dir left|right, deg                calibrated turn (timed)
    drive       dir forward|backward|left|right, power (expr, %)   start driving, keep going
    motors      left, right (expr, %)              raw wheel power, no trim
    stop                                           motors off
    wait        sec (expr)
    beep        hz (expr), sec (expr), wait (bool)
    repeat      times (expr), body
    forever     body
    if          cond, then, else (optional)
    wait_until  cond
    repeat_until cond, body
    set         var, value      change   var, by
    reset_timer
    end                                            program ends here
    call        name, args [expr, ...]             run a function
Expressions: a number, or {"op": ...}:
    num value | var name | sensor name (distance light button timer line_left line_right)
    bin fn (+ - * / % < > = <= >= != and or) a b | not a | neg a | random lo hi
Values are integers on the robot; fractional numbers are rounded (except seconds, which become ms first).
"""

import math

from bytecode import (CALL_MAX, Assembler, Label, MOVE_KEEP_DRIVING, PROG_MAX, SENSORS, VARS_MAX, cdiv,
                      disassemble, verify)

# Which raw line sensor is on the robot's left (looking where its face looks): sensor 1 (D9). Checked on the
# robot 2026-10-18 (right eye over the line -> sensor 2 reads black). The old notes' "bit0 = left" was wrong.
LINE_LEFT, LINE_RIGHT = "line1", "line2"
MAX_STATEMENTS = 600
MAX_DEPTH = 24
MAX_MOVE_MS = 60000           # MOVE's ms operand is 16 bit; longer moves are split
BEEP_HZ = (100, 5000)

BIN_OPS = {"+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "<": "LT", ">": "GT", "=": "EQ",
           "<=": "LE", ">=": "GE", "!=": "NE", "and": "AND", "or": "OR"}
SENSOR_EXPR = {"distance", "light", "button", "timer", "line_left", "line_right"}


class CompileError(Exception):
    """Shown to the user as is (German). .block: id of the block it is about, if known."""

    def __init__(self, message, block=None):
        super().__init__(message)
        self.block = block


def _num(value, what="Zahl"):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise CompileError(f"Ungültige {what}.")
    if not math.isfinite(v):
        raise CompileError(f"Ungültige {what}.")
    return v


def _fold(fn, a, b):
    """Constant folding with the robot's integer semantics."""
    a, b = int(round(a)), int(round(b))
    if fn == "/":
        return 0 if b == 0 else cdiv(a, b)
    if fn == "%":
        return 0 if b in (0, -1) else a - b * cdiv(a, b)
    return {"+": a + b, "-": a - b, "*": a * b, "<": a < b, ">": a > b, "=": a == b, "<=": a <= b,
            ">=": a >= b, "!=": a != b, "and": bool(a) and bool(b), "or": bool(a) or bool(b)}[fn]


class Compiler:
    def __init__(self, cal):
        self.cal = cal
        self.asm = Assembler()
        self.vars = {}            # name -> slot (user variables first come first served)
        self.hidden = []          # hidden slots (repeat counters, parameters): keys, numbered after the user's
        self.count = 0
        self.functions = {}       # name -> definition from the syntax tree
        self.fn = None            # name of the function being compiled (None = main program)
        self.fn_labels = {}       # name -> Label, for every function that is called
        self.fn_ranges = {}       # name -> (first, end) index into asm.items
        self.call_graph = {None: set()}

    # --- variables
    def var(self, name):
        name = " ".join(str(name or "").split())
        if not name:
            raise CompileError("Eine Variable hat keinen Namen.")
        if self.fn is not None and name in self.functions[self.fn]["params"]:
            return self.slot(("param", self.fn, name))    # a parameter hides a variable with the same name
        if name not in self.vars:
            self.vars[name] = len(self.vars)
        return self.vars[name]

    def slot(self, key):
        """A hidden slot (patched to a real slot number in finish())."""
        if key not in self.hidden:
            self.hidden.append(key)
        return key

    def temp(self, depth):
        """Hidden slot for nesting level `depth`; each function has its own, so a call inside a loop can't
        overwrite the loop's counter."""
        return self.slot(("temp", self.fn, depth))

    def function(self, name):
        """The label of a function, compiled later (once, however often it is called)."""
        if name not in self.functions:
            raise CompileError(f"Den Block „{name}“ gibt es nicht (mehr).")
        self.call_graph.setdefault(self.fn, set()).add(name)
        if name not in self.fn_labels:
            self.fn_labels[name] = Label(f"fn:{name}")
        return self.fn_labels[name]

    # --- expressions
    def const(self, e):
        """The value of a constant expression, else None."""
        if isinstance(e, (int, float)) and not isinstance(e, bool):
            return _num(e)
        if not isinstance(e, dict):
            raise CompileError("Ein Feld ist leer – setz eine Zahl oder einen Baustein ein.")
        op = e.get("op")
        if op == "num":
            return _num(e.get("value"))
        if op == "neg":
            a = self.const(e.get("a"))
            return None if a is None else -a
        if op == "not":
            a = self.const(e.get("a"))
            return None if a is None else float(not round(a))
        if op == "bin":
            a, b = self.const(e.get("a")), self.const(e.get("b"))
            if a is None or b is None:
                return None
            if e.get("fn") not in BIN_OPS:
                raise CompileError(f"Unbekannte Rechenart: {e.get('fn')}")
            if e.get("fn") in ("+", "-", "*") and (a != int(a) or b != int(b)):
                return {"+": a + b, "-": a - b, "*": a * b}[e["fn"]]    # keep 0.5 * 2 exact
            return float(_fold(e["fn"], a, b))
        return None

    def expr(self, e, depth=0):
        if depth > MAX_DEPTH:
            raise CompileError("Zu tief verschachtelt.")
        c = self.const(e)
        if c is not None:
            self.asm.push(round(c))
            return
        op = e.get("op")
        if op == "var":
            self.asm.emit("LOAD", self.var(e.get("name")))
        elif op == "sensor":
            name = e.get("name")
            if name not in SENSOR_EXPR:
                raise CompileError(f"Unbekannter Sensor: {name}")
            if name in ("line_left", "line_right"):        # 1 = over black (the raw sensor says 0 there)
                self.asm.emit("SENS", SENSORS[LINE_LEFT if name == "line_left" else LINE_RIGHT])
                self.asm.emit("NOT")
            else:
                self.asm.emit("SENS", SENSORS[name])
        elif op == "bin":
            fn = e.get("fn")
            if fn not in BIN_OPS:
                raise CompileError(f"Unbekannte Rechenart: {fn}")
            self.expr(e.get("a"), depth + 1)
            self.expr(e.get("b"), depth + 1)
            self.asm.emit(BIN_OPS[fn])
        elif op in ("not", "neg"):
            self.expr(e.get("a"), depth + 1)
            self.asm.emit(op.upper())
        elif op == "random":
            self.expr(e.get("lo"), depth + 1)
            self.expr(e.get("hi"), depth + 1)
            self.asm.emit("RAND")
        else:
            raise CompileError(f"Unbekannter Baustein: {op}")

    def scaled(self, e, factor, divisor=1):
        """expr * factor / divisor, folded when constant (used for % -> PWM and s -> ms)."""
        c = self.const(e)
        if c is not None:
            self.asm.push(round(c * factor / divisor))
            return
        self.expr(e)
        if factor != 1:
            self.asm.push(round(factor))
            self.asm.emit("MUL")
        if divisor != 1:
            self.asm.push(divisor)
            self.asm.emit("DIV")

    # --- motors
    def pwm(self, percent):
        return max(-255, min(255, round(percent * 2.55)))

    def motors(self, left, right):
        """left/right: (expr, factor) pairs in % * factor/10000 -> PWM; handles "Vorne ist die andere Seite"."""
        if self.cal.get("reverse"):
            (left, lneg), (right, rneg) = (right, True), (left, True)
        else:
            lneg = rneg = False
        for (e, factor), neg in ((left, lneg), (right, rneg)):
            self.scaled(e, -factor if neg else factor, 10000)
        self.asm.emit("MOTORS")

    def move(self, left, right, ms):
        """Timed drive with the calibration's settle pause, as MOVE instructions."""
        if self.cal.get("reverse"):
            left, right = -right, -left
        pause = max(0, min(254, round(self.cal["settle_ms"] / 10)))
        ms = max(1, round(ms))
        while ms > 0:
            part = min(ms, MAX_MOVE_MS)
            ms -= part
            self.asm.emit("MOVE", left, right, part, pause if ms == 0 else MOVE_KEEP_DRIVING)

    # --- statements
    def block(self, stmts, depth):
        if not isinstance(stmts, list):
            raise CompileError("Ungültiges Programm.")
        for s in stmts:
            self.stmt(s, depth)

    def stmt(self, s, depth):
        try:
            self._stmt(s, depth)
        except CompileError as exc:
            if exc.block is None and isinstance(s, dict):
                exc.block = s.get("id")              # the innermost block: inner statements set it first
            raise

    def _stmt(self, s, depth):
        if depth > MAX_DEPTH:
            raise CompileError("Zu tief verschachtelt.")
        self.count += 1
        if self.count > MAX_STATEMENTS:
            raise CompileError(f"Zu viele Bausteine (höchstens {MAX_STATEMENTS}).")
        if not isinstance(s, dict):
            raise CompileError("Ungültiges Programm.")
        asm, cal, kind = self.asm, self.cal, s.get("do")
        outer = asm.owner
        asm.owner = s.get("id", outer)
        if kind == "move":
            steps = max(0.1, min(50.0, _num(s.get("steps", 1))))
            sign = 1 if s.get("dir") != "backward" else -1
            v, t = self.pwm(cal["speed"]), cal["trim"] / 100
            self.move(sign * min(255, round(v * (1 - t))), sign * min(255, round(v * (1 + t))),
                      steps * cal["forward_ms"])
        elif kind == "turn":
            deg = max(5.0, min(720.0, _num(s.get("deg", 90))))
            v = self.pwm(cal["turn_speed"])
            left = s.get("dir") == "left"
            ms = cal["turn_left_ms" if left else "turn_right_ms"] * deg / 90
            self.move(-v, v, ms) if left else self.move(v, -v, ms)
        elif kind == "drive":
            p = s.get("power", 50)
            trim = cal["trim"]
            k_l, k_r = 255 * (100 - trim), 255 * (100 + trim)
            d = s.get("dir")
            if d == "forward":
                self.motors((p, k_l), (p, k_r))
            elif d == "backward":
                self.motors((p, -k_l), (p, -k_r))
            elif d == "left":
                self.motors((p, -25500), (p, 25500))
            elif d == "right":
                self.motors((p, 25500), (p, -25500))
            else:
                raise CompileError(f"Unbekannte Richtung: {d}")
        elif kind == "motors":
            self.motors((s.get("left", 0), 25500), (s.get("right", 0), 25500))
        elif kind == "stop":
            asm.push(0)
            asm.push(0)
            asm.emit("MOTORS")
        elif kind == "wait":
            self.scaled(s.get("sec", 1), 1000)
            asm.emit("WAIT")
        elif kind == "beep":
            c_hz = self.const(s.get("hz", 880))
            if c_hz is not None:
                asm.push(max(BEEP_HZ[0], min(BEEP_HZ[1], round(c_hz))))
            else:
                self.expr(s.get("hz"))
            c_sec = self.const(s.get("sec", 0.25))
            if c_hz is not None and c_sec is not None and s.get("wait", True):
                asm.items.pop()                          # the hz pushed above: NOTE carries it itself
                asm.emit("NOTE", max(BEEP_HZ[0], min(BEEP_HZ[1], round(c_hz))), max(1, min(65535, round(c_sec * 1000))))
            elif c_sec is not None:
                ms = max(1, round(c_sec * 1000))
                asm.push(ms)
                asm.emit("TONE")
                if s.get("wait", True):
                    asm.push(ms)
                    asm.emit("WAIT")
            else:
                slot = self.temp(depth)
                self.scaled(s.get("sec"), 1000)
                asm.emit("STORE", slot)
                asm.emit("LOAD", slot)
                asm.emit("TONE")
                if s.get("wait", True):
                    asm.emit("LOAD", slot)
                    asm.emit("WAIT")
        elif kind == "repeat":
            times = s.get("times", 10)
            c = self.const(times)
            end, top = Label("end"), Label("top")
            if c is not None and round(c) <= 0:
                pass                                     # never runs
            else:
                slot = self.temp(depth)
                self.expr(times)
                asm.emit("STORE", slot)
                if c is None:                            # a variable might be 0 or negative
                    asm.emit("LOAD", slot)
                    asm.push(0)
                    asm.emit("GT")
                    asm.emit("JZ", end)
                asm.label(top)
                self.block(s.get("body", []), depth + 1)
                asm.owner = s.get("id", outer)
                asm.emit("LOOP", slot, top)
                asm.label(end)
        elif kind == "forever":
            top = Label("top")
            asm.label(top)
            self.block(s.get("body", []), depth + 1)
            asm.owner = s.get("id", outer)
            asm.emit("JMP", top)
        elif kind == "if":
            other, end = Label("else"), Label("end")
            self.expr(s.get("cond"))
            asm.emit("JZ", other)
            self.block(s.get("then", []), depth + 1)
            asm.owner = s.get("id", outer)
            if s.get("else"):
                asm.emit("JMP", end)
                asm.label(other)
                self.block(s["else"], depth + 1)
                asm.label(end)
            else:
                asm.label(other)
        elif kind == "wait_until":
            top = Label("top")
            asm.label(top)
            self.expr(s.get("cond"))
            asm.emit("JZ", top)
        elif kind == "repeat_until":
            top, end = Label("top"), Label("end")
            asm.label(top)
            self.expr(s.get("cond"))
            asm.emit("JNZ", end)
            self.block(s.get("body", []), depth + 1)
            asm.owner = s.get("id", outer)
            asm.emit("JMP", top)
            asm.label(end)
        elif kind == "set":
            self.expr(s.get("value", 0))
            asm.emit("STORE", self.var(s.get("var")))
        elif kind == "change":
            slot = self.var(s.get("var"))
            asm.emit("LOAD", slot)
            self.expr(s.get("by", 1))
            asm.emit("ADD")
            asm.emit("STORE", slot)
        elif kind == "call":
            name = str(s.get("name") or "")
            label = self.function(name)
            params, args = self.functions[name]["params"], s.get("args") or []
            if len(args) != len(params):
                raise CompileError(f"„{name}“ braucht {len(params)} Eingabe(n).")
            for a in args:
                self.expr(a)
            for p in reversed(params):
                asm.emit("STORE", self.slot(("param", name, p)))
            asm.emit("CALL", label)
        elif kind == "reset_timer":
            asm.emit("TRESET")
        elif kind == "end":
            asm.emit("HALT")
        else:
            raise CompileError(f"Unbekannter Baustein: {kind}")
        asm.owner = outer

    def compile_functions(self):
        """Every called function once, after the main program; they may call more functions."""
        done = set()
        while set(self.fn_labels) - done:
            name = sorted(set(self.fn_labels) - done)[0]
            done.add(name)
            fn = self.functions[name]
            self.fn = name
            self.asm.owner = fn.get("id")
            first = len(self.asm.items)
            self.asm.label(self.fn_labels[name])
            self.block(fn.get("body") or [], 0)
            self.asm.owner = fn.get("id")
            self.asm.emit("RET")
            self.fn_ranges[name] = (first, len(self.asm.items))
        self.fn = None

    def check_calls(self):
        """No recursion (it would never end), and not deeper than the robot's return stack."""
        def depth(name, path):
            if name in path:
                raise CompileError(f"„{name}“ benutzt sich selbst – dann würde es nie fertig.",
                                   self.functions[name].get("id"))
            callees = self.call_graph.get(name, set())
            return max((1 + depth(c, path + (name,)) for c in callees), default=0)
        deepest = max((1 + depth(c, ()) for c in self.call_graph[None]), default=0)
        if deepest > CALL_MAX:
            raise CompileError(f"Zu viele Blöcke ineinander ({deepest}, höchstens {CALL_MAX}).")

    def finish(self):
        self.asm.owner = None
        self.asm.emit("HALT")
        self.compile_functions()
        self.check_calls()
        base = len(self.vars)
        slot_of = {key: base + i for i, key in enumerate(self.hidden)}
        for item in self.asm.items:
            item[1] = [slot_of.get(a, a) if isinstance(a, tuple) else a for a in item[1]]
        nvars = base + len(self.hidden)
        if nvars > VARS_MAX:
            raise CompileError(f"Zu viele Variablen, Eingaben und verschachtelte Wiederholungen (höchstens {VARS_MAX}).")
        code, owners = self.asm.assemble()
        if len(code) > PROG_MAX:
            raise CompileError(f"Das Programm ist zu groß für den Roboter ({len(code)} von {PROG_MAX} Bytes).")
        bad = verify(code, nvars)
        if bad is not None:
            raise CompileError(f"Interner Fehler im Übersetzer (Befehl {bad}).")
        return {"code": code, "nvars": nvars, "owners": owners,
                "vars": [n for n, _ in sorted(self.vars.items(), key=lambda kv: kv[1])],
                "durations": self.durations(), "size": len(code), "max_size": PROG_MAX}

    def durations(self):
        """ms per block for straight-line timed code (moves, notes, constant waits, calls of such functions) –
        the simple mode's progress bars."""
        items = self.asm.items

        def own_ms(i):
            name, args, _ = items[i]
            if name == "MOVE":
                return args[2] + (args[3] * 10 if args[3] != MOVE_KEEP_DRIVING else 0)
            if name == "NOTE":
                return args[1]
            if name == "WAIT":
                prev = next((items[j] for j in range(i - 1, -1, -1) if items[j][0] != "LABEL"), None)
                if prev and prev[0].startswith("PUSH") and not isinstance(prev[1][0], tuple):
                    return max(0, prev[1][0])
            if name == "CALL":
                return fn_ms(args[0].name[3:])
            return 0

        totals = {}

        def fn_ms(name):
            if name not in totals:
                totals[name] = 0                     # no recursion (checked), this only guards the lookup
                first, end = self.fn_ranges[name]
                totals[name] = sum(own_ms(i) for i in range(first, end))
            return totals[name]

        out = {}
        for i, (_, _, owner) in enumerate(items):
            ms = own_ms(i)
            if ms and owner is not None:
                out[owner] = out.get(owner, 0) + ms
        return out


def compile_program(ast, cal):
    """-> dict(code, nvars, owners [(pc, id)], vars [names by slot], size, max_size). Raises CompileError."""
    if not isinstance(ast, dict) or not isinstance(ast.get("body"), list):
        raise CompileError("Ungültiges Programm.")
    if not ast["body"]:
        raise CompileError("Das Programm ist leer.")
    c = Compiler(cal)
    functions = ast.get("functions") or {}
    if not isinstance(functions, dict):
        raise CompileError("Ungültiges Programm.")
    for name, fn in functions.items():
        if not isinstance(fn, dict) or not isinstance(fn.get("params", []), list):
            raise CompileError("Ungültiges Programm.")
        c.functions[str(name)] = {"params": [str(p) for p in fn.get("params", [])], "body": fn.get("body") or [],
                                  "id": fn.get("id")}
    c.block(ast["body"], 0)
    return c.finish()


def listing(result):
    return disassemble(result["code"], result["owners"])


def owner_at(owners, pc):
    """The block id of the instruction at pc (owners is sorted by pc)."""
    lo, hi, found = 0, len(owners) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if owners[mid][0] <= pc:
            found, lo = owners[mid][1], mid + 1
        else:
            hi = mid - 1
    return found
