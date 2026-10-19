# Usage

The firmware must be on the robot first: [flashing.md](flashing.md). The GUI follows the browser's language
(English or German); the button at the top right switches.

## Start and connect

```sh
./start.sh                          # http://localhost:8000
./start.sh serial:/dev/ttyUSB0      # connect over USB right away
./start.sh wifi:192.168.1.50        # … over the Pico W bridge
./start.sh ble:AA:BB:CC:DD:EE:FF    # … over Makeblock's BLE module
./stop.sh                           # stop the server; the robot stops too
```

On start the server retries the last working connection (`server/settings.json`) three times, then opens the
connect dialog. `--host 0.0.0.0` on `server/mbot_server.py` makes the GUI reachable from a tablet; there is no
login.

- **USB:** always works.
- **WiFi:** [Pico W bridge](pico-bridge.md); *Search* finds it.
- **Bluetooth LE:** Makeblock's BLE module. On KDE, disconnect the robot in the Bluetooth applet first (leave it
  paired).
- **Simulator:** `python3 sim/fake_mbot.py`, then pick "Simulator". A black circle (40 cm radius) to follow and
  walls for the distance sensor; every start puts the robot back on the line.

## Calibration

Robot on the floor, battery switch on (USB only powers the logic), about 1 m of space. **⚙ Calibration** walks
through speed, one step, driving straight and 90° turns: test, measure, enter, adjust, **Save**
(`server/calibration.json`). Recalibrate when the batteries change noticeably.

"Forward" is the end with the face and sensors; a checkbox flips it.

## Simple mode

A list of big blocks: forward, backward, turn, wait, honk. Saved programs appear under **My programs** and can be
dragged in like any block.

## Advanced mode

Loops, conditions, sensors, variables, random numbers, and own blocks with inputs (**My Blocks**). One program,
two views:

- **Blocks:** Blockly. Only the stack under *when ▶ Start clicked* runs; an arrow points at the running block, a
  warning sign marks one that can't be compiled.
- **Flowchart:** arranges itself top to bottom. A question forks into a green *yes* and a red *no* lane; a loop
  is an orange arrow back up. Tap a ＋ on an arrow and then blocks in the palette, or drag blocks onto arrows.
  Values (sensors, variables, random) are dragged into number fields or onto a question. Delete doesn't ask;
  ↶ Undo (Ctrl+Z) brings things back.

Switching views keeps the program. Formulas the flowchart's menus can't show stay as text; loose stacks in
Blocks (not under the start block) have no place in the flowchart, and the page warns about them.

## Saved programs

**💾 Save** stores a program under a name and symbol; **⚙ Manage** loads, renames, copies and deletes. A saved
program used as a block is stored on the robot once and called, so each use costs 3 bytes; programs can use
programs up to 8 deep. Changing a saved program changes every program that uses it. Saving refuses a program that
would use itself; deleting refuses one that is still used.

The bar above the program shows how much of the robot's 768 bytes it needs, or why it can't run. **What the robot
senses** shows sensors, motors, stopwatch and variables live.

On first start the list holds four examples (`server/examples.json`); your programs live in
`server/programs.json`.

## Remote control

Arrow keys (anywhere outside text fields), the on-screen pad, or a game controller's left stick; space or A honks.
Steering stops a running program. The robot stops by itself 500 ms after the last command, so a dead browser or
link stops it.

Browsers only expose controllers to secure pages: open the GUI as `http://localhost:8000` on the PC the controller
is plugged into, and press a button once. Only the left stick is used, because Firefox on Linux reports the Xbox
controller's right stick as buttons.
