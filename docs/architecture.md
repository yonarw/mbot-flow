# How it works

```
 browser (German GUI)   ──HTTP──►  server/mbot_server.py   ──USB / WiFi (Pico) / BLE──►  firmware/mbot_vm
   web/  Einfach | Profi           compiler.py: blocks → bytecode                         runs the bytecode,
         ◄──── live (SSE) ────     (uses calibration.json)       ◄──── telemetry ────     reads the sensors
```

The page sends a program to the server, which compiles it to bytecode and uploads it to the robot **as a
whole**. A small virtual machine runs it on the robot itself, sensors included, so link latency only matters
while uploading – never between moves, or between "see the line" and "steer". The robot streams back where it
is in the program and what its sensors see, and the page shows that live.

The VM, its instruction set and the wire protocol: [vm.md](vm.md).

## Pieces

| Path | What |
|---|---|
| `web/` | The GUI: plain HTML/CSS/JS, no build step, works offline. `app.js` simple mode and the shell, `advanced.js` Profi block definitions (workspace → syntax tree), `flow.js` the flowchart view |
| `web/vendor/blockly/` | Blockly 12.5.1 + continuous toolbox, vendored and loaded on demand ([README](../web/vendor/blockly/README.md)) |
| `server/mbot_server.py` | HTTP API, live events (SSE), serial/WiFi/BLE link, autoconnect, program store, simple blocks → syntax tree |
| `server/compiler.py` | syntax tree → bytecode, using the calibration for timed moves |
| `server/bytecode.py` | opcodes, assembler, disassembler, and the reference VM that the tests and the simulator run |
| `firmware/mbot_vm/` | the firmware: plain Arduino, no Makeblock library |
| `sim/fake_mbot.py` | a fake robot on a pseudo-terminal, running the reference VM in a made-up world |
| `pico_bridge/` | MicroPython WiFi ↔ serial bridge for a Pico W in the Bluetooth module's socket |
| `factory/`, `restore_factory.sh` | Makeblock's original firmware sources, to go back |
| `tools/` | `setup.sh` (toolchain), `acli` (project-local arduino-cli), `read_flash.py` (flash backup) |
| `tests/` | compiler, VM, program store and autoconnect tests; a check that the firmware's opcode table matches `bytecode.py` |

## One syntax tree for everything

Both modes produce the same syntax tree: the simple mode's block list is turned into it by the server
(`blocks_to_ast`), Profi's Blockly workspace and flowchart by the page. The compiler only knows the tree.

Switching Profi between **Blöcke** and **Ablauf** converts through that tree, keeping every statement's id, so
the running-block highlight and compile errors find their block in either view. Going back without a change
keeps the other view's own document (Blockly's positions).

Saved programs used as blocks are compiled once as functions and called (`CALL`/`RET`), not inlined. The
server expands them by name when a program runs, refuses recursion, and limits nesting to 8.

## Data

| File | |
|---|---|
| `server/programs.json` | saved programs; created from `server/examples.json` on the first start |
| `server/calibration.json` | speeds and timings from the calibration dialog |
| `server/settings.json` | the last connection that worked, for autoconnect |

None of them is in git.

## HTTP API

| | |
|---|---|
| `GET /api/state`, `GET /api/events` | connection, robot state and calibration; live telemetry as server-sent events |
| `GET /api/ports`, `/api/scan`, `/api/scan-wifi` | serial ports, BLE devices, Pico bridges on the network |
| `POST /api/connect`, `/api/disconnect` | link to the robot |
| `POST /api/compile` | compile without running (memory bar, errors); `"listing": true` also returns the disassembly |
| `POST /api/run`, `/api/stop` | upload + start, stop |
| `POST /api/remote` | `{fwd, turn, horn}` → one `M <left> <right> 500` line (and `H <hz> 300`); the page repeats it every 150 ms while a key is held, and the firmware stops by itself 500 ms after the last one |
| `GET /api/programs`, `POST /api/programs/{save,load,delete,rename,duplicate}` | program store |
| `POST /api/calibration` | save the calibration |

## Development

```sh
python3 -m unittest discover tests     # no robot needed
python3 sim/fake_mbot.py               # fake robot; pick "Simulator" in the connect dialog
./build.sh                             # check that the firmware compiles
```

Opcode numbers live in `server/bytecode.py`; the firmware mirrors them and a test checks that they match.
The firmware's protocol version must equal the server's (`PING` → `PONG mbot_vm <ver>`), so bump both when the
instruction set changes.
