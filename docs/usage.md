# Using mbot-flow

The GUI is in German (it's made for kids); this page explains it in English. Getting the firmware onto the
robot first: [flashing.md](flashing.md).

## Start and connect

```sh
./start.sh                                   # then open http://localhost:8000
./start.sh serial:/dev/ttyUSB0               # connect right away over the USB cable
./start.sh wifi:192.168.1.50                 # … over WiFi through the Pico W bridge
./start.sh ble:AA:BB:CC:DD:EE:FF             # … over the Makeblock BLE module (untested, see below)
./stop.sh                                    # stop the server (also from another terminal); the robot stops too
```

`uv` fetches the Python dependencies (`pyserial`, `bleak`) by itself. At startup the server tries the last
connection that worked (`server/settings.json`, or `--connect`) up to 3 times in the background; the status
chip shows the attempts, and only if all fail does the page open the connect dialog, with the reason.

Use `--host 0.0.0.0` on `server/mbot_server.py` to open the GUI from a tablet in the same network. There is no
login – only do that on a network you trust.

* **USB cable** – always works, also for flashing.
* **WiFi (Pico W)** – a Raspberry Pi Pico W in the Bluetooth module's socket, see
  [`pico_bridge/wiring.html`](../pico_bridge/wiring.html). Once:
  `cp pico_bridge/wifi_config.example.py pico_bridge/wifi_config.py`, enter WiFi name and password (not in
  git), Pico on USB, `./pico_bridge/upload.sh /dev/ttyACM0` (check the port). In the GUI: "Per WLAN (Pico)" →
  Suchen. The GUI finds the Pico with a UDP broadcast (`MBOT?` on port 2324) and talks TCP on port 2323.
* **BLE** – Makeblock's BLE module (GATT FFE3 write / FFE2 notify). Not tried with this firmware yet. On KDE,
  disconnect the robot in the Bluetooth applet first (leave it paired), or BlueZ won't let the server connect.
* **Simulator** – `python3 sim/fake_mbot.py` starts a fake robot on a pseudo-terminal; it shows up as
  "Simulator" in the connect dialog. It runs uploaded programs with the same reference VM as the tests, in
  real time, in a made-up world: a black circle of 40 cm radius to follow (the robot starts on it) and walls
  for the ultrasonic sensor. Each RUN puts the robot back at the start.

## Calibration (before the first drive)

Switch the robot on (battery switch – USB alone only powers the logic), put it on the floor with ~1 m free
space, then open **⚙ Kalibrierung** and work through the steps (tempo → one step → straight line → 90° turns).
Each step has a test button; measure what the robot did, type it in, press "anpassen". **Speichern** at the
end stores the values in `server/calibration.json`.

Turns and distances are **timed** (the mBot has no encoders), so recalibrate when the batteries change
noticeably. "Forward" is the end with the face, ultrasonic and line sensor. "Vorne ist die andere Seite"
flips that, if you want the castor-ball end to lead.

## The two modes

Switched at the top right.

### Einfach (simple)

Big blocks in a list: Vorwärts, Drehen, Warten, Hupen, and saved programs as blocks. Made for kids who can't
read much yet.

### Profi

Loops, conditions, sensors, variables, "fahre los … bis …", and own blocks with inputs ("Meine Blöcke").
One program, two views, switched next to the title:

* **Blöcke** – Scratch-like blocks ([Blockly](../web/vendor/blockly/README.md)). Only the stack under
  **Wenn ▶ Start geklickt** runs; a green arrow points at the block the robot is in, a warning sign marks a
  block that can't be compiled.
* **Ablauf** – the same program as a flowchart that lays itself out: boxes joined by thick arrows top to
  bottom. A question ⬡ carries a green "ja" and a red "nein" tag and forks into two lanes that join again; a
  loop is an orange arrow back up. Each fork and loop sits on its own tinted area and is dragged as a whole.
  * Adding: tap a ＋ on an arrow and then blocks in the palette (each goes in after the last), or drag a block
    onto an arrow – with the mouse or a finger.
  * Deleting doesn't ask: ↶ Rückgängig (Ctrl+Z) brings things back.
  * Questions are picked from a menu ("Linie links schwarz?", "Taste gedrückt?") or compare two values
    ("Abstand < 10 cm?"). Values are blocks of their own in the palette – sensors (Abstand, Helligkeit,
    Stoppuhr in seconds), variables, 🎲 Zufall von … bis … – dragged into any number field, either side of a
    comparison, or onto a question (which becomes "value > 0"); numbers are typed in directly.
  * A formula built in "Blöcke" that the menus can't show (`Abstand < x + 5`, "und"/"oder") stays as it is,
    shown as text.
  * The running box glows green, a box that can't be compiled gets a ⚠.

Switching views keeps the program; going back without a change keeps the other view exactly as it was. Only
stacks lying loose in "Blöcke" (not under the start block) have no place in "Ablauf" – the page warns. A saved
Profi program opens in either view.

"Neu" and "Laden" (and "Leeren" in the simple mode) only ask when the program has unsaved changes.

## Saved programs as blocks

Every program saved with **💾 Speichern** also shows up in the **Meine Programme** box and can be dragged (or
tapped) into another program like any other block, as a sub-program. The block refers to the program by
name, so overwriting a saved program changes every program that uses it. While it runs, the sub-program's
block lights up as one step.

* A sub-program is stored on the robot once and *called* wherever it is used, so reusing one costs 3 bytes
  per use – the memory bar shows it. Programs may use programs, up to 8 deep.
* In "Meine Programme", the program being edited and every program that uses it are greyed out (they would
  make it use itself); a block that can't work is marked red right away. Saving refuses a program that would
  end up using itself; deleting refuses a program another one still uses.
* Profi programs are saved in the same list but can't be used as blocks in the simple mode.

**⚙ Verwalten** (or **📂 Laden**) lists all saved programs: load, rename / change symbol (programs using it,
and the editor, follow the new name), copy ("… (Kopie)"), delete. Each row shows its mode, blocks, how much
robot memory it needs and where it is used. On the first start the list holds four examples
(Quadrat, Für Elise, Linie folgen, Hindernis ausweichen – `server/examples.json`); your own programs live in `server/programs.json`.

A bar above the program shows how much of the robot's 768 bytes of program memory it needs, or why it can't
run (an empty field, a missing program).

The **Was der Roboter sieht** card shows the sensors (line follower, distance, light, button), the motors, the
stopwatch and the program's variables live, also when no program runs.

## Remote control

The **Fernsteuerung** card, or the keyboard anywhere on the page (outside text fields and dialogs): hold the
arrow keys to drive, combine ↑/↓ with ←/→ to steer in a curve, press **space** to honk a random note.
Steering takes over from a running program (it stops it). If the browser, the server or the link dies, the
robot stops within half a second by itself.

A game controller works too (browser Gamepad API): the left stick drives and steers, A / ✕ honks. The stick
is proportional, from 30 % power when barely pushed to 100 % all the way; steering harder slows the inner
wheel more. The arrow keys win while one of them is held.

* Only the left stick, because Firefox on Linux reports the right stick of the Xbox Wireless Controller
  (Bluetooth) as buttons instead of axes.
* Press a button once after plugging it in – browsers only reveal a controller after that.
* Browsers only report controllers to secure pages, so it works when the GUI is opened as
  `http://localhost:8000` on the PC the controller is plugged into, not over `http://<ip>` from another device
  ([Mozilla](https://hacks.mozilla.org/2020/07/securing-gamepad-api/); Chromium does the same).
