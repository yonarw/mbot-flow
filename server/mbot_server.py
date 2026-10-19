#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial", "bleak"]
# ///
"""Web server for the mBot block programming GUI.

    uv run server/mbot_server.py                 # http://localhost:8000
    uv run server/mbot_server.py --host 0.0.0.0  # reachable from other devices on the network

Compiles block programs to bytecode (compiler.py, bytecode.py) for the mbot_vm firmware
(firmware/mbot_vm/mbot_vm.ino, docs/vm.md) and talks to it over a serial port (USB cable, or the fake
robot from sim/fake_mbot.py), over WiFi through a Pico W standing in for the Bluetooth module
(pico_bridge/main.py), or over BLE (Makeblock BLE module, FFE3 write / FFE2 notify). The robot's telemetry
reaches the browser as server-sent events.
"""

import argparse
import asyncio
import glob
import json
import math
import queue
import signal
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from bytecode import FAULTS, MODES, PROG_MAX, VERSION, crc16
from compiler import LINE_LEFT, CompileError, compile_program, listing, owner_at

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"
CAL_FILE = HERE / "calibration.json"
SETTINGS_FILE = HERE / "settings.json"
PROGRAMS_FILE = HERE / "programs.json"
EXAMPLES_FILE = HERE / "examples.json"    # copied to programs.json on the first start

BLE_WRITE_UUID = "0000ffe3-0000-1000-8000-00805f9b34fb"
BLE_NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
BLE_CHUNK = 20            # the BLE module takes at most 20 bytes per write
PICO_TCP_PORT = 2323      # pico_bridge/main.py
PICO_DISCOVERY_PORT = 2324

DEFAULT_CAL = {
    "speed": 55,          # % of full motor power for driving straight
    "turn_speed": 50,     # % of full motor power while turning on the spot
    "forward_ms": 900,    # how long one "Schritt" lasts at `speed`
    "turn_left_ms": 450,  # how long a 90 degree turn to the left lasts
    "turn_right_ms": 450,
    "trim": 0,            # -30..30: >0 makes the right wheel faster (fixes drifting to the right)
    "settle_ms": 150,     # coast time after every move so turns start from standstill
    "reverse": False,     # True if the end with the ball castor is the robot's "front"
    "step_cm": 20,        # only used by the GUI to turn a measured distance into forward_ms
}
CAL_LIMITS = {
    "speed": (25, 100), "turn_speed": (25, 100), "forward_ms": (100, 5000),
    "turn_left_ms": (50, 3000), "turn_right_ms": (50, 3000), "trim": (-30, 30),
    "settle_ms": (0, 1000), "step_cm": (1, 200),
}
MAX_BLOCKS = 80
BLOCK_PARAMS = {"forward": ["n"], "backward": ["n"], "left": ["deg"], "right": ["deg"], "wait": ["sec"],
                "beep": ["hz", "sec"], "program": []}   # "program": a saved program, by "name", expanded at run time
MAX_NESTING = 8           # programs inside programs inside ...
MAX_WORKSPACE = 300_000   # bytes of JSON for a saved Profi document (Blockly workspace or flowchart)
BLOCK_DEFAULTS = {("beep", "hz"): 880, ("beep", "sec"): 0.25}    # parameters that older saved programs may lack
BEEP_HZ = (100, 5000)
BEEP_SEC = (0.05, 5.0)
REMOTE_TTL_MS = 500       # the robot stops by itself unless the next remote command comes within this time;
                          # the GUI repeats every 150 ms while a key is held, so one lost request doesn't stop it
REMOTE_HORN_MS = 300
AUTOCONNECT_TRIES = 3      # at startup: how often to try the last connection before the GUI asks
AUTOCONNECT_PAUSE_S = 2
UPLOAD_CHUNK = 24         # program bytes per "W" line (the firmware's line buffer holds 63 characters)
TELEMETRY_MS = 50
REMOTE_CURVE = 0.35       # inner wheel speed (fraction of the outer one) when steering fully while driving
REMOTE_STICK_POWER = (30, 100)   # % motor power for a controller stick: barely pushed .. pushed all the way
                                 # (below ~30 % the wheels don't turn, see the calibration dialog)
MAX_SAVED = 200
MAX_NAME = 40
MAX_SYMBOL = 8            # characters; an emoji with modifiers can be several code points
DEFAULT_SYMBOL = "⭐"


class UserError(Exception):
    """Something the GUI should show to the user as a message; .block: the block it is about, if known."""

    def __init__(self, message, block=None):
        super().__init__(message)
        self.block = block


def load_json(path, default):
    try:
        return {**default, **json.loads(path.read_text())}
    except (OSError, ValueError):
        return dict(default)


def clean_cal(raw):
    cal = dict(DEFAULT_CAL)
    for key, default in DEFAULT_CAL.items():
        if key not in raw:
            continue
        if isinstance(default, bool):
            cal[key] = bool(raw[key])
        else:
            try:
                value = float(raw[key])
            except (TypeError, ValueError):
                raise UserError(f"Ungültiger Wert für {key}")
            lo, hi = CAL_LIMITS[key]
            cal[key] = round(max(lo, min(hi, value)), 2)
    return cal


# --- saved programs -------------------------------------------------------

class ProgramStore:
    """Named programs kept in one JSON file. Names are unique, ignoring case.

    Simple programs: {name, symbol, blocks}. Advanced (Profi) programs: {name, symbol, kind: "advanced",
    workspace (the document of the view it was saved in, to edit it again: Blockly's own JSON, or the flowchart's
    {main, functions, vars}), ast (what the compiler gets)}."""

    def __init__(self, path):
        self._path = path
        self._lock = threading.Lock()

    def _read(self):
        try:
            data = json.loads(self._path.read_text())
        except (OSError, ValueError):
            return []
        return [p for p in data if isinstance(p, dict)] if isinstance(data, list) else []

    def _write(self, programs):
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(programs, indent=2, ensure_ascii=False))
        tmp.replace(self._path)               # atomic: a crash never leaves half a file

    @staticmethod
    def _find(programs, name):
        return next((i for i, p in enumerate(programs) if p.get("name", "").casefold() == name.casefold()), None)

    @staticmethod
    def _clean_blocks(blocks):
        if not isinstance(blocks, list) or not blocks:
            raise UserError("Das Programm ist leer.")
        if len(blocks) > MAX_BLOCKS:
            raise UserError(f"Zu viele Bausteine (höchstens {MAX_BLOCKS}).")
        clean = []
        for b in blocks:
            kind = b.get("type") if isinstance(b, dict) else None
            if kind not in BLOCK_PARAMS:
                raise UserError(f"Unbekannter Baustein: {kind}")
            item = {"type": kind}
            if kind == "program":
                name = " ".join(str(b.get("name") or "").split())
                if not name or len(name) > MAX_NAME:
                    raise UserError("Ungültiger Programm-Baustein.")
                item["name"] = name
            for key in BLOCK_PARAMS[kind]:
                try:
                    value = float(b[key] if key in b else BLOCK_DEFAULTS[kind, key])
                except (KeyError, TypeError, ValueError):
                    value = float("nan")
                if not math.isfinite(value):
                    raise UserError(f"Ungültige Einstellung bei Baustein '{kind}'")
                item[key] = int(value) if value.is_integer() else value
            clean.append(item)
        return clean

    @staticmethod
    def _clean_name(name):
        name = " ".join(str(name or "").split())
        if not name:
            raise UserError("Bitte gib dem Programm einen Namen.")
        if len(name) > MAX_NAME:
            raise UserError(f"Der Name ist zu lang (höchstens {MAX_NAME} Zeichen).")
        return name

    @staticmethod
    def _clean_symbol(symbol):
        symbol = str(symbol or "").strip() or DEFAULT_SYMBOL
        if len(symbol) > MAX_SYMBOL:
            raise UserError("Ungültiges Symbol.")
        return symbol

    @staticmethod
    def _uses(program):
        """Names of the saved programs this one uses directly (as written in its blocks)."""
        return [b["name"] for b in program.get("blocks", []) if isinstance(b, dict) and b.get("type") == "program"]

    def list(self, cal):
        """Overview for the GUI, including how many bytes each program takes on the robot (None if it can't run)."""
        with self._lock:
            programs = [p for p in self._read() if "name" in p and "symbol" in p and ("blocks" in p or "ast" in p)]
        lookup = {p["name"].casefold(): p for p in programs}
        out = []
        for p in programs:
            advanced = p.get("kind") == "advanced"
            try:
                ast = p["ast"] if advanced else blocks_to_ast(p["blocks"], lambda n: self._get(lookup, n), p["name"])
                size = compile_ast(ast, cal)["size"]
            except UserError:
                size = None
            out.append({"name": p["name"], "symbol": p["symbol"], "kind": "advanced" if advanced else "simple",
                        "blocks": count_statements(p["ast"]) if advanced else len(p["blocks"]), "size": size,
                        "saved": p.get("saved", 0),
                        "used_by": [q["name"] for q in programs
                                    if any(n.casefold() == p["name"].casefold() for n in self._uses(q))]})
        return out

    def load(self, name):
        with self._lock:
            programs = self._read()
            i = self._find(programs, str(name))
            if i is None:
                raise UserError("Dieses Programm gibt es nicht (mehr).")
            return programs[i]

    def save(self, name, symbol, blocks=None, workspace=None, ast=None):
        name, symbol = self._clean_name(name), self._clean_symbol(symbol)
        if workspace is not None:
            # unfinished programs may be saved too, so the AST is only checked for shape, not compiled
            if not isinstance(workspace, dict) or not isinstance(ast, dict) or not isinstance(ast.get("body"), list):
                raise UserError("Ungültiges Programm.")
            if len(json.dumps(workspace)) > MAX_WORKSPACE:
                raise UserError("Das Programm ist zu groß zum Speichern.")
            entry = {"name": name, "symbol": symbol, "kind": "advanced", "workspace": workspace, "ast": ast,
                     "saved": int(time.time())}
        else:
            entry = {"name": name, "symbol": symbol, "blocks": self._clean_blocks(blocks), "saved": int(time.time())}
        with self._lock:
            programs = self._read()
            i = self._find(programs, name)
            if i is not None and (programs[i].get("kind") == "advanced") != (entry.get("kind") == "advanced"):
                raise UserError(f"„{programs[i]['name']}“ ist ein Programm aus dem anderen Modus. Wähle einen anderen Namen.")
            # every program it uses must exist, and none may lead back to it (that would never end)
            lookup = {p.get("name", "").casefold(): p for p in programs}
            lookup[name.casefold()] = entry
            if entry.get("blocks"):
                blocks_to_ast(entry["blocks"], lambda n: self._get(lookup, n), name)
            if i is not None:
                programs[i] = entry               # same name: overwrite
            elif len(programs) >= MAX_SAVED:
                raise UserError(f"Es sind schon {MAX_SAVED} Programme gespeichert. Lösche zuerst eins.")
            else:
                programs.append(entry)
            self._write(programs)
        return {"name": name, "symbol": symbol, "replaced": i is not None}

    @staticmethod
    def _get(lookup, name):
        if name.casefold() not in lookup:
            raise UserError(f"Das Programm „{name}“ gibt es nicht (mehr).")
        return lookup[name.casefold()]

    def load_for_run(self, name):
        with self._lock:
            return self._get({p.get("name", "").casefold(): p for p in self._read()}, name)

    def delete(self, name):
        with self._lock:
            programs = self._read()
            i = self._find(programs, str(name))
            if i is None:
                raise UserError("Dieses Programm gibt es nicht (mehr).")
            users = [p["name"] for p in programs
                     if any(n.casefold() == programs[i]["name"].casefold() for n in self._uses(p))]
            if users:
                raise UserError(f"„{programs[i]['name']}“ wird in „{users[0]}“ benutzt. Nimm es dort zuerst heraus.")
            del programs[i]
            self._write(programs)

    def rename(self, name, new_name, symbol):
        """New name and/or symbol; programs that use it are updated to the new name."""
        new_name, symbol = self._clean_name(new_name), self._clean_symbol(symbol)
        with self._lock:
            programs = self._read()
            i = self._find(programs, str(name))
            if i is None:
                raise UserError("Dieses Programm gibt es nicht (mehr).")
            j = self._find(programs, new_name)
            if j is not None and j != i:
                raise UserError(f"„{programs[j]['name']}“ gibt es schon. Wähle einen anderen Namen.")
            old = programs[i]["name"]
            programs[i] = {**programs[i], "name": new_name, "symbol": symbol}
            for p in programs:
                for b in p.get("blocks", []):
                    if isinstance(b, dict) and b.get("type") == "program" and str(b.get("name", "")).casefold() == old.casefold():
                        b["name"] = new_name
            self._write(programs)
        return {"name": new_name, "symbol": symbol, "old": old}

    def duplicate(self, name):
        with self._lock:
            programs = self._read()
            i = self._find(programs, str(name))
            if i is None:
                raise UserError("Dieses Programm gibt es nicht (mehr).")
            if len(programs) >= MAX_SAVED:
                raise UserError(f"Es sind schon {MAX_SAVED} Programme gespeichert. Lösche zuerst eins.")
            n = 1
            while True:
                suffix = " (Kopie)" if n == 1 else f" (Kopie {n})"
                copy = programs[i]["name"][:MAX_NAME - len(suffix)].rstrip() + suffix
                if self._find(programs, copy) is None:
                    break
                n += 1
            programs.append({**programs[i], "name": copy, "saved": int(time.time())})
            self._write(programs)
        return {"name": copy}


PROGRAMS = ProgramStore(PROGRAMS_FILE)


# --- blocks -> program --------------------------------------------------------

def simple_stmt(b, sid):
    """One simple-mode block (not a saved program) as a compiler statement."""
    kind = b.get("type")
    try:
        if kind in ("forward", "backward"):
            return {"id": sid, "do": "move", "dir": kind, "steps": max(0.1, min(50.0, float(b.get("n", 1))))}
        if kind in ("left", "right"):
            return {"id": sid, "do": "turn", "dir": kind, "deg": max(5.0, min(720.0, float(b.get("deg", 90))))}
        if kind == "wait":
            return {"id": sid, "do": "wait", "sec": max(0.1, min(60.0, float(b.get("sec", 1))))}
        if kind == "beep":
            hz = max(BEEP_HZ[0], min(BEEP_HZ[1], round(float(b.get("hz", BLOCK_DEFAULTS["beep", "hz"])))))
            sec = max(BEEP_SEC[0], min(BEEP_SEC[1], float(b.get("sec", BLOCK_DEFAULTS["beep", "sec"]))))
            return {"id": sid, "do": "beep", "hz": hz, "sec": sec, "wait": True}
    except (TypeError, ValueError):
        raise UserError(f"Ungültige Einstellung bei Baustein '{kind}'")
    raise UserError(f"Unbekannter Baustein: {kind}")


def blocks_to_ast(blocks, load=PROGRAMS.load_for_run, name=None):
    """The simple mode's block list as a compiler syntax tree.

    Saved programs used as blocks become functions (compiled once, called wherever they are used). load(name)
    returns a saved program; `name` is the program being edited, which therefore can't use itself.
    Top-level statement ids are the block indexes; an error names the top-level block it comes from (.block)."""
    if not blocks:
        raise UserError("Das Programm ist leer.")
    functions = {}

    def convert(blocks, prefix, stack):
        body = []
        for i, b in enumerate(blocks):
            sid = f"{prefix}{i}"
            try:
                if not (isinstance(b, dict) and b.get("type") == "program"):
                    body.append(simple_stmt(b if isinstance(b, dict) else {}, sid))
                    continue
                sub_name = str(b.get("name", ""))
                if sub_name.casefold() in stack:
                    raise UserError(f"„{sub_name}“ benutzt sich selbst – dann würde es nie fertig.")
                if len(stack) >= MAX_NESTING:
                    raise UserError(f"Zu viele Programme ineinander (höchstens {MAX_NESTING}).")
                sub = load(sub_name)
                if sub.get("kind") == "advanced":
                    raise UserError(f"„{sub_name}“ ist ein Profi-Programm und kann hier nicht als Baustein benutzt werden.")
                fname = sub["name"]
                if fname not in functions:
                    functions[fname] = {"params": [], "body": []}      # reserved: the body may use it again
                    functions[fname]["body"] = convert(sub.get("blocks", []), f"{fname}/", stack + (fname.casefold(),))
                body.append({"id": sid, "do": "call", "name": fname})
            except UserError as exc:
                if not prefix and exc.block is None:
                    exc.block = sid
                raise
        return body

    body = convert(blocks, "", (name.casefold(),) if name else ())
    return {"body": body, "functions": functions}


def compile_ast(ast, cal):
    try:
        return compile_program(ast, cal)
    except CompileError as exc:
        raise UserError(str(exc), exc.block)


def count_statements(ast):
    def walk(stmts):
        return sum(1 + walk(s.get("body", [])) + walk(s.get("then", [])) + walk(s.get("else", []) or [])
                   for s in stmts if isinstance(s, dict)) if isinstance(stmts, list) else 0
    return walk(ast.get("body", [])) if isinstance(ast, dict) else 0


def request_ast(body):
    """The program of a /api/run or /api/compile request: simple blocks or an advanced mode syntax tree."""
    if "ast" in body:
        return body["ast"]
    blocks = body.get("blocks") or []
    if len(blocks) > MAX_BLOCKS:
        raise UserError(f"Zu viele Bausteine (höchstens {MAX_BLOCKS}).")
    return blocks_to_ast(blocks, name=body.get("name") or None)


def remote_wheels(fwd, turn, cal, analog=False):
    """Wheel power (-255..255 each) for one remote-control command.

    fwd: -1..1 (+ = forward); turn: -1..1 (+ = right). Keys (analog=False) send ±1 and drive at the calibrated
    speeds; a controller stick (analog=True) scales the power over REMOTE_STICK_POWER with how far it is pushed."""
    def power(key, amount):
        lo, hi = REMOTE_STICK_POWER
        return math.copysign((lo + (hi - lo) * abs(amount) if analog else cal[key]) * 2.55, amount)

    if fwd:
        v, t = power("speed", fwd), cal["trim"] / 100
        left, right = v * (1 - t), v * (1 + t)
        inner = 1 - abs(turn) * (1 - REMOTE_CURVE)     # the further you steer, the slower the inner wheel
        if turn < 0:
            left *= inner
        elif turn > 0:
            right *= inner
    elif turn:
        v = power("turn_speed", turn)
        left, right = v, -v                       # left (v < 0): left wheel back, right wheel forward
    else:
        return 0, 0
    left, right = min(255, max(-255, round(left))), min(255, max(-255, round(right)))
    if cal["reverse"]:
        left, right = -right, -left
    return left, right


# --- links (transport) ----------------------------------------------------

class SerialLink:
    """USB cable (/dev/ttyUSB0), a classic rfcomm port, or the simulator's pty."""

    def __init__(self, path, on_data, on_close):
        import serial
        self.name = path
        self._on_data, self._on_close = on_data, on_close
        self._ser = serial.Serial()
        self._ser.port, self._ser.baudrate, self._ser.timeout = path, 115200, 0.2
        self._ser.open()                          # a USB open resets the board; connect() pings until it answers
        self._alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while self._alive:
                # wait for one byte (up to the timeout), then take whatever else has arrived; read(256) would
                # sit out the full 0.2 s timeout on every short reply and make uploads crawl
                data = self._ser.read(1)
                if data and self._ser.in_waiting:
                    data += self._ser.read(self._ser.in_waiting)
                if data:
                    self._on_data(data)
        except Exception:
            pass
        finally:
            if self._alive:
                self._alive = False
                self._on_close()

    def write(self, data):
        self._ser.write(data)

    def close(self):
        self._alive = False
        try:
            self._ser.close()
        except Exception:
            pass


class TcpLink:
    """Pico W WiFi bridge (pico_bridge/main.py): the robot's serial line over TCP."""

    def __init__(self, target, on_data, on_close):
        host, _, port = target.rpartition(":") if target.count(":") == 1 else (target, "", "")
        self.name = target
        self._on_data, self._on_close = on_data, on_close
        self._sock = socket.create_connection((host or target, int(port or PICO_TCP_PORT)), timeout=5)
        self._sock.settimeout(None)
        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while self._alive:
                data = self._sock.recv(256)
                if not data:
                    break
                self._on_data(data)
        except OSError:
            pass
        finally:
            if self._alive:
                self._alive = False
                self._on_close()

    def write(self, data):
        self._sock.sendall(data)

    def close(self):
        self._alive = False
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
            self._sock.close()
        except OSError:
            pass


def wifi_scan(seconds=1.5):
    """Ask every Pico bridge on the local network to report its address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.2)
    found, end = {}, time.time() + seconds
    try:
        for _ in range(3):
            s.sendto(b"MBOT?", ("255.255.255.255", PICO_DISCOVERY_PORT))
        while time.time() < end:
            try:
                data, _addr = s.recvfrom(64)
            except socket.timeout:
                continue
            parts = data.decode("ascii", "ignore").split()
            if len(parts) == 3 and parts[0] == "MBOT":
                found[f"{parts[1]}:{parts[2]}"] = True
    finally:
        s.close()
    return [{"address": a, "name": "mBot (WLAN)"} for a in found]


class BleLink:
    """Makeblock BLE module: GATT write FFE3 / notify FFE2, bridged to the board's UART."""

    def __init__(self, address, on_data, on_close):
        self.name = address
        self._on_data, self._on_close = on_data, on_close
        self._loop = asyncio.new_event_loop()
        self._stop = None
        self._ready = threading.Event()
        self._error = None
        self._client = None
        self._connected = False     # only a link that was up can be "lost"
        self._alive = True
        threading.Thread(target=self._run, daemon=True).start()
        if not self._ready.wait(25) or self._error:
            self.close()
            raise UserError(self._error or "Bluetooth-Verbindung hat zu lange gedauert.")

    def _run(self):
        self._loop.run_until_complete(self._main())

    async def _main(self):
        from bleak import BleakClient
        self._stop = asyncio.Event()
        try:
            async with BleakClient(self.name, timeout=15) as client:
                self._client = client
                await client.start_notify(BLE_NOTIFY_UUID, lambda _char, data: self._on_data(bytes(data)))
                self._connected = True
                self._ready.set()
                done = asyncio.ensure_future(self._stop.wait())
                gone = asyncio.ensure_future(self._watch(client))
                await asyncio.wait([done, gone], return_when=asyncio.FIRST_COMPLETED)
        except Exception as exc:
            self._error = f"Bluetooth: {exc}"
            if "not found" in str(exc):
                self._error = ("Roboter nicht gefunden. Ist er eingeschaltet und blinkt die LED am "
                               "Bluetooth-Modul? (Dauerlicht = schon mit einem anderen Gerät verbunden)")
        finally:
            self._ready.set()
            if self._alive and self._connected:
                self._alive = False
                self._on_close()

    @staticmethod
    async def _watch(client):
        while client.is_connected:
            await asyncio.sleep(0.5)

    async def _write(self, data):
        for i in range(0, len(data), BLE_CHUNK):
            await self._client.write_gatt_char(BLE_WRITE_UUID, data[i:i + BLE_CHUNK], response=False)

    def write(self, data):
        asyncio.run_coroutine_threadsafe(self._write(data), self._loop).result(5)

    def close(self):
        self._alive = False
        if self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)


def ble_scan(seconds=6):
    from bleak import BleakScanner

    async def go():
        found = await BleakScanner.discover(timeout=seconds)
        return [{"address": d.address, "name": d.name or ""} for d in found]

    return asyncio.run(go())


def list_ports():
    from serial.tools import list_ports as lp

    found = []
    for p in sorted(lp.comports(), key=lambda p: p.device):
        if p.vid == 0x1A86:                      # CH340: the USB-serial chip on the mCore
            label = f"mBot (USB-Kabel) – {p.device}"
        elif p.device.startswith(("/dev/ttyUSB", "/dev/ttyACM")):
            label = f"{p.description or 'USB-Gerät'} – {p.device}"
        else:
            continue
        found.append({"path": p.device, "label": label})
    found += [{"path": p, "label": f"Bluetooth-Seriell – {p}"} for p in sorted(glob.glob("/dev/rfcomm*"))]
    sim = HERE.parent / "sim" / "tty"          # created by sim/fake_mbot.py while it runs
    if sim.exists():
        found.append({"path": str(sim), "label": "Simulator (ohne Roboter)"})
    return found


# --- robot ----------------------------------------------------------------

class Robot:
    """The connection to the mbot_vm firmware: uploads programs, remote control, and the telemetry it streams."""

    def __init__(self):
        self._rx = b""
        self._lock = threading.RLock()
        self._link = None
        self._replies = queue.Queue()
        self.changed = threading.Condition()     # notified on every telemetry line / state change (SSE)
        self.version = 0
        self.link_name = None
        self.firmware = None
        self.prog_max = PROG_MAX
        self.auto = None            # startup autoconnect: {"state": "trying"|"failed", ...} for the GUI, None when done
        self.running = False
        self.error = None
        self._loaded = None         # (code, nvars) the robot holds, so an unchanged program isn't uploaded again
        self._program = None        # compile result of what runs / ran last
        self._idle_since = None     # telemetry says idle while we think it runs: DONE got lost?
        self.tel = None             # last telemetry: dict
        self._vars = []
        self._block = None          # the block the program is in
        self._top = None            # ... or, inside a sub-program, the (outermost) block that called it
        self._top_since = 0.0

    def _changed(self):
        with self.changed:
            self.version += 1
            self.changed.notify_all()

    # --- link events (called from reader threads)
    def _on_data(self, data):
        self._rx += data
        while b"\n" in self._rx:
            raw, self._rx = self._rx.split(b"\n", 1)
            text = raw.decode("ascii", "ignore").strip("\r\x00 ")
            if text:
                self._on_line(text)

    def _on_line(self, line):
        parts = line.split()
        kind = parts[0]
        if kind == "T" and len(parts) >= 10:
            try:
                mode, pc, line_raw, dist, light, button, left, right, timer = map(int, parts[1:10])
            except ValueError:
                return
            call_pc = int(parts[10]) if len(parts) > 10 and parts[10].lstrip("-").isdigit() else pc
            self.tel = {"mode": MODES.get(mode, "idle"), "pc": pc, "line": line_raw, "distance": dist,
                        "light": light, "button": button, "left": left, "right": right, "timer": timer}
            if mode == 1:
                self.running, self._idle_since = True, None
                owners = self._program["owners"] if self._program else []
                self._block = owner_at(owners, pc)
                top = owner_at(owners, call_pc)             # inside a sub-program: the block that called it
                if top != self._top:
                    self._top, self._top_since = top, time.time()
            elif self.running:
                self._idle_since = self._idle_since or time.time()
                if time.time() - self._idle_since > 0.5:
                    self._ended()
            self._changed()
        elif kind == "V" and len(parts) >= 2:
            try:
                first, values = int(parts[1]), [int(v) for v in parts[2:]]
            except ValueError:
                return
            need = first + len(values)
            if len(self._vars) < need:
                self._vars += [0] * (need - len(self._vars))
            self._vars[first:need] = values
        elif kind in ("DONE", "STOPPED"):
            self._ended()
        elif kind == "FAULT":
            self._ended()
            code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            self.error = f"Das Programm ist abgebrochen: {FAULTS.get(code, f'Fehler {code}')}."
            self._changed()
        elif kind == "READY":
            self._loaded = None                     # the board was reset (USB open, brown-out): program gone
            self._ended()
        else:
            self._replies.put(line)

    def _ended(self):
        self.running, self._idle_since, self._block, self._top = False, None, None, None
        self._changed()

    def _on_close(self):
        self._link, self.link_name, self.firmware, self._loaded, self.tel = None, None, None, None, None
        self.error = "Verbindung zum Roboter verloren."
        self._ended()

    # --- helpers
    def _request(self, line, timeout=2.0):
        while not self._replies.empty():
            self._replies.get_nowait()
        self._link.write((line + "\n").encode())
        try:
            return self._replies.get(timeout=timeout)
        except queue.Empty:
            raise UserError("Der Roboter antwortet nicht.")

    @staticmethod
    def _check(reply):
        if reply != "OK":
            raise UserError(f"Roboter meldet: {reply}")

    def connected(self):
        return self._link is not None

    def connect(self, kind, target):
        with self._lock:
            self.disconnect()
            self.error = None
            try:
                cls = {"ble": BleLink, "wifi": TcpLink}.get(kind, SerialLink)
                self._rx = b""
                self._link = cls(target, self._on_data, self._on_close)
            except UserError:
                raise
            except Exception as exc:
                raise UserError(f"Verbinden nicht möglich: {exc}")
            self.link_name = target
            # a USB open resets the board; keep asking until the firmware answers
            for _ in range(8):
                try:
                    reply = self._request("PING", timeout=0.6)
                except UserError:
                    continue
                if reply.startswith("PONG mbot_vm"):
                    try:
                        version = int(reply.split()[2])
                    except (IndexError, ValueError):
                        version = 0
                    if version != VERSION:
                        self.disconnect()
                        raise UserError(f"Die Firmware auf dem Roboter ist Version {version}, der Server braucht "
                                        f"Version {VERSION}. Spiel die passende mit ./flash.sh auf.")
                    self.firmware = reply
                    try:
                        self.prog_max = int(reply.split()[3])
                    except (IndexError, ValueError):
                        pass
                    self._check(self._request(f"TEL {TELEMETRY_MS}"))
                    self.auto = None
                    self._changed()
                    return
                if reply.startswith("PONG"):
                    self.disconnect()
                    raise UserError("Auf dem Roboter ist noch die alte Firmware. Spiel die neue mit ./flash.sh auf.")
            self.disconnect()
            raise UserError("Verbunden, aber der Roboter antwortet nicht. Ist die mbot_vm-Firmware installiert (./flash.sh)?")

    def disconnect(self):
        with self._lock:
            link, self._link = self._link, None
            if link:
                try:
                    link.write(b"STOP\n")
                except Exception:
                    pass
                link.close()
            self.link_name, self.firmware, self._loaded, self.tel = None, None, None, None
            self._ended()

    def run(self, ast, cal):
        result = compile_ast(ast, cal)
        with self._lock:
            if not self.connected():
                raise UserError("Der Roboter ist nicht verbunden.")
            code, nvars = result["code"], result["nvars"]
            if len(code) > self.prog_max:
                raise UserError(f"Das Programm ist zu groß für den Roboter ({len(code)} von {self.prog_max} Bytes).")
            self._link.write(b"STOP\n")           # also ends remote control
            if self._loaded != (code, nvars):
                self._loaded = None
                self._check(self._request(f"LOAD {len(code)} {nvars}"))
                for i in range(0, len(code), UPLOAD_CHUNK):
                    self._check(self._request("W " + code[i:i + UPLOAD_CHUNK].hex()))
                self._check(self._request(f"END {crc16(code):04X}"))
                self._loaded = (code, nvars)
            self._program, self._vars = result, [0] * nvars
            self._block, self._top, self.error = None, None, None
            self._check(self._request("RUN"))
            self.running, self._idle_since = True, None
            self._changed()

    def remote(self, fwd, turn, horn_hz, cal, analog=False):
        """Drive now; the robot stops by itself unless the next command comes within REMOTE_TTL_MS.
        Fire and forget, no reply to wait for. Takes over from a running program."""
        left, right = remote_wheels(fwd, turn, cal, analog)
        with self._lock:
            if not self.connected():
                raise UserError("Der Roboter ist nicht verbunden.")
            cmd = f"M {left} {right} {REMOTE_TTL_MS}\n"
            if horn_hz:
                cmd += f"H {max(BEEP_HZ[0], min(BEEP_HZ[1], round(horn_hz)))} {REMOTE_HORN_MS}\n"
            self._link.write(cmd.encode())

    def stop(self):
        with self._lock:
            if self._link:
                self._link.write(b"STOP\n")
            self._ended()

    def state(self):
        tel, prog = self.tel, self._program
        block = self._block if self.running else None
        top = self._top if self.running else None
        block_ms = done_ms = None
        if top is not None and prog and prog["durations"].get(top):     # progress bars: simple mode, top level
            block_ms = prog["durations"][top]
            done_ms = min(block_ms, round((time.time() - self._top_since) * 1000))
        sensors = None
        if tel:
            left_bit = 0 if LINE_LEFT == "line2" else 1           # raw: bit1 = sensor 1, bit0 = sensor 2; 0 = black
            black = lambda bit: (tel["line"] >> bit) & 1 == 0
            sensors = {"line_left": black(left_bit), "line_right": black(1 - left_bit),
                       "distance": tel["distance"], "light": tel["light"], "button": bool(tel["button"]),
                       "timer": tel["timer"], "motor_left": round(tel["left"] / 2.55), "motor_right": round(tel["right"] / 2.55),
                       "mode": tel["mode"]}
        names = prog["vars"] if prog else []
        return {
            "connected": self.connected(), "link": self.link_name, "firmware": self.firmware,
            "running": self.running, "max_size": self.prog_max, "auto": self.auto,
            "block": block, "top_block": top, "block_ms": block_ms, "block_done_ms": done_ms,
            "sensors": sensors,
            "vars": [{"name": n, "value": self._vars[i] if i < len(self._vars) else 0} for i, n in enumerate(names)],
            "error": self.error,
        }


ROBOT = Robot()


def remember_connection(kind, target):
    SETTINGS_FILE.write_text(json.dumps({"kind": kind, "target": target}))


def last_connection():
    """(kind, target) of the last successful connection, or None."""
    s = load_json(SETTINGS_FILE, {})
    if s.get("kind") in ("serial", "wifi", "ble") and s.get("target"):
        return s["kind"], s["target"]
    return None


def autoconnect(robot, kind, target, tries=AUTOCONNECT_TRIES, pause=AUTOCONNECT_PAUSE_S, sleep=time.sleep):
    """Try a connection a few times (at startup, in the background). robot.auto tells the GUI how it goes;
    after the last failed try it says "failed" and the GUI opens the connect dialog."""
    error = None
    for attempt in range(1, tries + 1):
        if robot.connected():                 # connected from the GUI meanwhile
            robot.auto = None
            robot._changed()
            return True
        robot.auto = {"state": "trying", "attempt": attempt, "tries": tries, "kind": kind, "target": target}
        robot._changed()
        try:
            robot.connect(kind, target)
            robot.auto = None
            robot._changed()
            remember_connection(kind, target)
            return True
        except UserError as exc:
            error = str(exc)
        if attempt < tries:
            sleep(pause)
    robot.auto = {"state": "failed", "tries": tries, "kind": kind, "target": target, "error": error}
    robot._changed()
    return False


# --- HTTP -----------------------------------------------------------------

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not any(p in str(args[0] if args else "") for p in ("/api/state", "/api/remote", "/api/compile", "/api/events")):
            super().log_message(fmt, *args)

    def _events(self):
        """Server-sent events: the robot state whenever it changes (at most every 50 ms), a heartbeat otherwise."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last, seen = None, -1
        try:
            while True:
                with ROBOT.changed:
                    if ROBOT.version == seen:
                        ROBOT.changed.wait(1.0)
                    seen = ROBOT.version
                data = json.dumps(ROBOT.state())
                if data != last:
                    self.wfile.write(f"data: {data}\n\n".encode())
                    last = data
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}") if length else {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/state":
            return self._json({**ROBOT.state(), "calibration": load_json(CAL_FILE, DEFAULT_CAL),
                               "settings": load_json(SETTINGS_FILE, {})})
        if path == "/api/ports":
            return self._json({"ports": list_ports()})
        if path == "/api/events":
            return self._events()
        if path == "/api/programs":
            return self._json({"programs": PROGRAMS.list(load_json(CAL_FILE, DEFAULT_CAL)),
                               "max_size": ROBOT.prog_max})
        if path == "/api/scan-wifi":
            try:
                return self._json({"devices": wifi_scan()})
            except OSError as exc:
                return self._json({"error": f"WLAN-Suche fehlgeschlagen: {exc}"}, 500)
        if path == "/api/scan":
            try:
                return self._json({"devices": ble_scan()})
            except Exception as exc:
                return self._json({"error": f"Bluetooth-Suche fehlgeschlagen: {exc}"}, 500)
        rel = "index.html" if path == "/" else path.lstrip("/")
        file = (WEB / rel).resolve()
        if WEB not in file.parents or not file.is_file():
            self.send_error(404)
            return
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            body = self._body()
            path = self.path
            if path == "/api/connect":
                kind, target = body.get("kind", "serial"), body.get("target", "")
                if not target:
                    raise UserError("Bitte eine Verbindung auswählen.")
                ROBOT.connect(kind, target)
                remember_connection(kind, target)
            elif path == "/api/disconnect":
                ROBOT.disconnect()
            elif path == "/api/run":
                cal = clean_cal(body["cal"]) if "cal" in body else load_json(CAL_FILE, DEFAULT_CAL)
                ROBOT.run(request_ast(body), cal)
            elif path == "/api/stop":
                ROBOT.stop()
            elif path == "/api/remote":
                def axis(key):
                    value = float(body.get(key, 0))
                    return max(-1.0, min(1.0, value)) if math.isfinite(value) else 0.0

                horn = body.get("horn")
                ROBOT.remote(axis("fwd"), axis("turn"), float(horn) if horn else None,
                             load_json(CAL_FILE, DEFAULT_CAL), bool(body.get("analog")))
            elif path == "/api/calibration":
                CAL_FILE.write_text(json.dumps(clean_cal(body), indent=2))
            elif path == "/api/programs/save":
                return self._json({"ok": True, **PROGRAMS.save(body.get("name"), body.get("symbol"), body.get("blocks"),
                                                               body.get("workspace"), body.get("ast"))})
            elif path == "/api/programs/load":
                return self._json({"ok": True, **PROGRAMS.load(body.get("name"))})
            elif path == "/api/programs/delete":
                PROGRAMS.delete(body.get("name"))
            elif path == "/api/programs/rename":
                return self._json({"ok": True, **PROGRAMS.rename(body.get("name"), body.get("new_name"), body.get("symbol"))})
            elif path == "/api/programs/duplicate":
                return self._json({"ok": True, **PROGRAMS.duplicate(body.get("name"))})
            elif path == "/api/compile":
                # how much of the robot's memory the editor's program needs, or why it can't run; with
                # "listing": true also the disassembly (for debugging the compiler)
                try:
                    result = compile_ast(request_ast(body), load_json(CAL_FILE, DEFAULT_CAL))
                    size, error, block = result["size"], None, None
                except UserError as exc:
                    result, size, error, block = None, None, str(exc), exc.block
                out = {"ok": True, "size": size, "error": error, "error_block": block, "max_size": ROBOT.prog_max}
                if body.get("listing") and result:
                    out["listing"] = listing(result)
                return self._json(out)
            else:
                self.send_error(404)
                return
            self._json({"ok": True})
        except UserError as exc:
            self._json({"ok": False, "error": str(exc)}, 400)
        except (ValueError, KeyError) as exc:
            self._json({"ok": False, "error": f"Ungültige Anfrage: {exc}"}, 400)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--connect", metavar="serial:/dev/ttyUSB0|wifi:192.168.1.50|ble:AA:BB:..",
                    help="connect at startup (default: the last connection that worked)")
    args = ap.parse_args()
    if not PROGRAMS_FILE.exists():
        PROGRAMS_FILE.write_bytes(EXAMPLES_FILE.read_bytes())
    target = None
    if args.connect:
        kind, _, addr = args.connect.partition(":")
        target = (kind, addr)
    else:
        target = last_connection()
    if target:
        def connect_in_background():
            ok = autoconnect(ROBOT, *target)
            print(f"Connected: {ROBOT.link_name} ({ROBOT.firmware})" if ok
                  else f"Autoconnect to {target[0]}:{target[1]} failed: {ROBOT.auto and ROBOT.auto['error']}")
        threading.Thread(target=connect_in_background, daemon=True).start()   # the GUI is up meanwhile
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mBot GUI: http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}")

    def on_term(_sig, _frame):            # ./stop.sh sends SIGTERM: clean up like Ctrl+C
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_term)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        ROBOT.stop()
        ROBOT.disconnect()


if __name__ == "__main__":
    main()
