# How it works

```
 browser                ──HTTP──►  server/mbot_server.py   ──USB / WiFi (Pico) / BLE──►  firmware/mbot_vm
   web/  simple | advanced         compiler.py: blocks → bytecode                         runs the bytecode,
         ◄──── live (SSE) ────     (uses calibration.json)       ◄──── telemetry ────     reads the sensors
```

The server compiles a program to bytecode and uploads it **as a whole**; a small VM runs it on the robot,
sensors included. Link latency only matters while uploading. The robot streams back its position in the program
and its sensor values, and the page shows them live. VM, instruction set and wire protocol: [vm.md](vm.md).

## Pieces

| Path | What |
|---|---|
| `web/` | The GUI: plain HTML/CSS/JS, no build step, works offline. `i18n.js` language, `app.js` simple mode and the shell, `advanced.js` Blockly blocks (workspace → syntax tree), `flow.js` the flowchart |
| `web/vendor/blockly/` | Blockly 12.5.1 + continuous toolbox, vendored and loaded on demand ([README](../web/vendor/blockly/README.md)) |
| `server/mbot_server.py` | HTTP API, live events (SSE), serial/WiFi/BLE link, autoconnect, program store, simple blocks → syntax tree |
| `server/compiler.py` | syntax tree → bytecode, using the calibration for timed moves |
| `server/bytecode.py` | opcodes, assembler, disassembler, and the reference VM that the tests and the simulator run |
| `firmware/mbot_vm/` | the firmware: plain Arduino, no Makeblock library |
| `sim/fake_mbot.py` | a fake robot on a pseudo-terminal, running the reference VM in a made-up world |
| `pico_bridge/` | MicroPython WiFi ↔ serial bridge for a Pico W in the Bluetooth module's socket |
| `factory/`, `restore_factory.sh` | Makeblock's original firmware sources, to go back |
| `tools/` | `setup.sh` (toolchain), `acli` (project-local arduino-cli), `read_flash.py` (flash backup) |
| `scripts/` | `make-social-preview.sh`: GitHub's link-card image from the README screenshot (uploaded by hand) |
| `tests/` | compiler, VM, program store, autoconnect and translation tests; a check that the firmware's opcode table matches `bytecode.py` |

## One syntax tree for everything

The simple mode's block list becomes a syntax tree on the server (`blocks_to_ast`); the Blockly workspace and
the flowchart become one in the page. The compiler only knows the tree.

Switching between Blocks and Flowchart converts through the tree and keeps every statement's id, so the
running-block highlight and compile errors work in both views. Switching back without a change keeps the other
view's document as it was.

Saved programs used as blocks are compiled once as functions and called (`CALL`/`RET`). The server expands them
by name when a program runs, refuses recursion and limits nesting to 8.

## Languages

German is the source text in the code; `web/i18n/en.json` maps it to English and is shared by page and server.
The page wraps its texts in `tr("…")` and translates the static HTML on load; the server renders its messages
(`Msg`, `server/i18n.py`) in the language the page sends (`X-Lang` header, `?lang=` for the event stream).
`tests/test_i18n.py` fails when a text has no translation or a translation is unused. Blockly's own texts come
from `vendor/blockly/msg/{de,en}.js`.

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
