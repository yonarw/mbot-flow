"""mbot_vm bytecode: opcodes, assembler, disassembler, CRC and a reference VM.

Source of truth for the instruction set (docs/vm.md explains it; firmware/mbot_vm/mbot_vm.ino mirrors it).
The reference VM is what sim/fake_mbot.py runs and what the tests check the compiler against; it behaves
like the firmware, including integer semantics, so a program that works here works on the robot.
"""

import random
import struct

VERSION = 2               # firmware protocol/instruction set version; PONG must report the same
PROG_MAX = 768
VARS_MAX = 16
STACK_MAX = 16
CALL_MAX = 8              # return stack: sub-programs inside sub-programs

# name: (opcode, operand struct format, little-endian)
OPS = {
    "HALT": (0x00, ""),
    "PUSH8": (0x01, "b"), "PUSH16": (0x02, "h"), "PUSH32": (0x03, "i"),
    "LOAD": (0x04, "B"), "STORE": (0x05, "B"), "DROP": (0x06, ""),
    "ADD": (0x10, ""), "SUB": (0x11, ""), "MUL": (0x12, ""), "DIV": (0x13, ""), "MOD": (0x14, ""), "NEG": (0x15, ""),
    "EQ": (0x18, ""), "NE": (0x19, ""), "LT": (0x1A, ""), "LE": (0x1B, ""), "GT": (0x1C, ""), "GE": (0x1D, ""),
    "AND": (0x1E, ""), "OR": (0x1F, ""), "NOT": (0x20, ""), "RAND": (0x21, ""),
    "JMP": (0x28, "H"), "JZ": (0x29, "H"), "JNZ": (0x2A, "H"), "LOOP": (0x2B, "BH"),
    "CALL": (0x2C, "H"), "RET": (0x2D, ""),
    "SENS": (0x30, "B"), "MOTORS": (0x31, ""), "WAIT": (0x32, ""), "TONE": (0x33, ""), "TRESET": (0x34, ""),
    "MOVE": (0x38, "hhHB"),
    "NOTE": (0x39, "HH"),     # hz, ms: play and wait (the compact form of a "Hupen" block)
}
BY_CODE = {code: (name, fmt) for name, (code, fmt) in OPS.items()}
JUMPS = {"JMP", "JZ", "JNZ", "LOOP", "CALL"}

SENSORS = {"line": 0, "line1": 1, "line2": 2, "distance": 3, "light": 4, "button": 5, "timer": 6,
           "motor_left": 7, "motor_right": 8}
SENSOR_NAMES = {v: k for k, v in SENSORS.items()}
MODES = {0: "idle", 1: "program", 2: "remote"}
FAULTS = {1: "Stapel voll (zu tief verschachtelt)", 2: "Stapel leer (Fehler im Übersetzer)",
          3: "zu viele Unterprogramme ineinander", 4: "Rücksprung ohne Aufruf (Fehler im Übersetzer)"}
MOVE_KEEP_DRIVING = 255       # MOVE pause value: don't stop at the end (a long move split into parts)
INT32 = (-2**31, 2**31 - 1)


def op_len(name):
    return 1 + struct.calcsize("<" + OPS[name][1])


def crc16(data):
    """CRC-16/CCITT-FALSE, same as avr-libc's _crc_xmodem_update starting from 0xFFFF."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def cdiv(a, b):
    """Integer division like C: truncates toward zero."""
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def wrap32(v):
    v &= 0xFFFFFFFF
    return v - 2**32 if v & 0x80000000 else v


# --- assembler ----------------------------------------------------------------

class Label:
    __slots__ = ("addr", "name")

    def __init__(self, name=""):
        self.addr, self.name = None, name


class Assembler:
    """Collects instructions; each one remembers the block that produced it (`owner`) for highlighting."""

    def __init__(self):
        self.items = []         # [name, args, owner]
        self.owner = None

    def emit(self, name, *args):
        self.items.append([name, list(args), self.owner])

    def push(self, value):
        value = int(value)
        if -128 <= value <= 127:
            self.emit("PUSH8", value)
        elif -32768 <= value <= 32767:
            self.emit("PUSH16", value)
        else:
            self.emit("PUSH32", max(INT32[0], min(INT32[1], value)))

    def label(self, lbl):
        self.items.append(["LABEL", [lbl], None])

    def assemble(self):
        """-> (code bytes, owners: list of (pc, owner), listing lines)."""
        addr = 0
        for name, args, _ in self.items:
            if name == "LABEL":
                args[0].addr = addr
            else:
                addr += op_len(name)
        code, owners = bytearray(), []
        for name, args, owner in self.items:
            if name == "LABEL":
                continue
            values = [a.addr if isinstance(a, Label) else a for a in args]
            opcode, fmt = OPS[name]
            owners.append((len(code), owner))
            code += bytes([opcode]) + struct.pack("<" + fmt, *values)
        return bytes(code), owners


def disassemble(code, owners=None):
    owner_at = dict(owners or [])
    out, pc = [], 0
    while pc < len(code):
        name, fmt = BY_CODE.get(code[pc], ("??", ""))
        size = struct.calcsize("<" + fmt)
        args = struct.unpack("<" + fmt, code[pc + 1:pc + 1 + size]) if fmt else ()
        text = f"{pc:4d}  {name:<7} {' '.join(str(a) for a in args)}"
        if name == "SENS":
            text += f"   ; {SENSOR_NAMES.get(args[0], '?')}"
        if owner_at.get(pc) is not None:
            text = f"{text:<34} ; block {owner_at[pc]}"
        out.append(text)
        pc += 1 + size
    return out


def verify(code, nvars):
    """Same checks as the firmware's verify(); returns None or the pc of the first bad instruction."""
    starts, pc = set(), 0
    while pc < len(code):
        entry = BY_CODE.get(code[pc])
        if entry is None:
            return pc
        name, fmt = entry
        size = 1 + struct.calcsize("<" + fmt)
        if pc + size > len(code):
            return pc
        if name in ("LOAD", "STORE", "LOOP") and code[pc + 1] >= nvars:
            return pc
        if name == "SENS" and code[pc + 1] not in SENSOR_NAMES:
            return pc
        starts.add(pc)
        pc += size
    for pc in sorted(starts):
        name, fmt = BY_CODE[code[pc]]
        if name in JUMPS:
            target = struct.unpack_from("<H", code, pc + (2 if name == "LOOP" else 1))[0]
            if target not in starts:
                return pc
    return None


# --- reference VM -----------------------------------------------------------------

class VM:
    """Runs bytecode like the firmware. Time is whatever `now_ms` says; `sensors` supplies the world.

    step_until(now_ms) runs until the program sleeps, ends or faults. Hooks: on_motors(l, r), on_tone(hz, ms)."""

    def __init__(self, code, nvars, sensors=None, on_motors=None, on_tone=None, rng=None):
        self.code, self.nvars = bytes(code), nvars
        self.sensors = sensors or (lambda name: 0)
        self.on_motors = on_motors or (lambda l, r: None)
        self.on_tone = on_tone or (lambda hz, ms: None)
        self.rng = rng or random.Random()
        self.vars = [0] * nvars
        self.stack = []
        self.calls = []             # return addresses
        self.pc = self.cur_pc = 0
        self.wake_at = None
        self.move_stage = 0
        self.timer_start = 0
        self.motors = (0, 0)
        self.state = "running"      # running | done | fault
        self.fault = None

    def drive(self, left, right):
        self.motors = (max(-255, min(255, left)), max(-255, min(255, right)))
        self.on_motors(*self.motors)

    @property
    def call_pc(self):
        """Where the outermost sub-program call is (the simple mode highlights that block), else cur_pc."""
        return self.calls[0] - op_len("CALL") if self.calls else self.cur_pc

    def sensor(self, sid, now):
        name = SENSOR_NAMES[sid]
        if name == "timer":
            return now - self.timer_start
        if name == "motor_left":
            return self.motors[0]
        if name == "motor_right":
            return self.motors[1]
        if name == "line":
            return (self.sensors("line1") << 1) | self.sensors("line2")
        return int(self.sensors(name))

    def _end(self, state, fault=None):
        self.state, self.fault = state, fault
        self.drive(0, 0)
        self.on_tone(0, 0)

    def step_until(self, now, budget=100000):
        """Run until sleeping/finished. budget guards tests against endless busy loops."""
        while self.state == "running" and budget > 0:
            if self.wake_at is not None:
                if now < self.wake_at:
                    return
                self.wake_at = None
            self.step(now)
            budget -= 1

    def _sleep(self, now, ms):
        self.wake_at = now + max(0, ms)

    def step(self, now):
        code, pc = self.code, self.pc
        if pc >= len(code):
            return self._end("done")
        self.cur_pc = pc
        name, fmt = BY_CODE[code[pc]]
        size = 1 + struct.calcsize("<" + fmt)
        args = struct.unpack_from("<" + fmt, code, pc + 1) if fmt else ()
        need = {"STORE": 1, "DROP": 1, "JZ": 1, "JNZ": 1, "WAIT": 1, "NEG": 1, "NOT": 1, "MOTORS": 2, "TONE": 2}.get(name, 0)
        if 0x10 <= code[pc] <= 0x21 and name not in ("NEG", "NOT"):
            need = 2
        give = 1 if name in ("PUSH8", "PUSH16", "PUSH32", "LOAD", "SENS") else 0
        st = self.stack
        if len(st) < need:
            return self._end("fault", 2)
        if len(st) - need + give > STACK_MAX:
            return self._end("fault", 1)
        nxt = pc + size
        if name == "HALT":
            return self._end("done")
        elif name.startswith("PUSH"):
            st.append(args[0])
        elif name == "LOAD":
            st.append(self.vars[args[0]])
        elif name == "STORE":
            self.vars[args[0]] = st.pop()
        elif name == "DROP":
            st.pop()
        elif name == "NEG":
            st[-1] = wrap32(-st[-1])
        elif name == "NOT":
            st[-1] = int(not st[-1])
        elif need == 2 and 0x10 <= code[pc] <= 0x21:
            b, a = st.pop(), st.pop()
            if name == "ADD":
                r = a + b
            elif name == "SUB":
                r = a - b
            elif name == "MUL":
                r = a * b
            elif name == "DIV":
                r = 0 if b == 0 else cdiv(a, b)
            elif name == "MOD":
                r = 0 if b in (0, -1) else a - b * cdiv(a, b)
            elif name == "RAND":
                lo, hi = min(a, b), max(a, b)
                r = self.rng.randint(lo, hi)
            else:
                r = int({"EQ": a == b, "NE": a != b, "LT": a < b, "LE": a <= b, "GT": a > b, "GE": a >= b,
                         "AND": bool(a) and bool(b), "OR": bool(a) or bool(b)}[name])
            st.append(wrap32(r))
        elif name == "JMP":
            nxt = args[0]
        elif name == "JZ":
            if st.pop() == 0:
                nxt = args[0]
        elif name == "JNZ":
            if st.pop() != 0:
                nxt = args[0]
        elif name == "CALL":
            if len(self.calls) >= CALL_MAX:
                return self._end("fault", 3)
            self.calls.append(nxt)
            nxt = args[0]
        elif name == "RET":
            if not self.calls:
                return self._end("fault", 4)
            nxt = self.calls.pop()
        elif name == "NOTE":
            hz, ms = args
            if self.move_stage == 0:
                self.on_tone(max(31, min(20000, hz)), ms)
                self.move_stage = 1
                return self._sleep(now, ms)
            self.move_stage = 0
        elif name == "LOOP":
            self.vars[args[0]] = wrap32(self.vars[args[0]] - 1)
            if self.vars[args[0]] > 0:
                nxt = args[1]
        elif name == "SENS":
            st.append(self.sensor(args[0], now))
        elif name == "MOTORS":
            right, left = st.pop(), st.pop()
            self.drive(left, right)
        elif name == "WAIT":
            ms = st.pop()
            self.pc = nxt
            if ms > 0:
                self._sleep(now, min(ms, 3600000))
            return
        elif name == "TONE":
            ms, hz = st.pop(), st.pop()
            self.on_tone(max(31, min(20000, hz)) if hz > 0 and ms > 0 else 0, min(ms, 60000) if hz > 0 and ms > 0 else 0)
        elif name == "TRESET":
            self.timer_start = now
        elif name == "MOVE":
            left, right, ms, pause = args
            if self.move_stage == 0:
                self.drive(left, right)
                self.move_stage = 1
                return self._sleep(now, ms)
            if self.move_stage == 1 and pause != MOVE_KEEP_DRIVING:
                self.drive(0, 0)
                self.move_stage = 2
                if pause:
                    return self._sleep(now, pause * 10)
            self.move_stage = 0
        self.pc = nxt
