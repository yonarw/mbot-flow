# mbot-flow

Self-hosted block and flowchart programming for the classic Makeblock **mBot** (mCore), made for kids – an
open-source alternative to mBlock. A small server on your PC serves the web GUI (English and German); programs
are compiled to bytecode and run **on the robot** by a custom firmware.

![The three editors: simple blocks, Blockly and the flowchart](docs/images/editors.png)

## Why?

- **Reaction time.** With the stock firmware (mBlock live mode) the program runs in the app: every sensor check is
  a round trip app → robot → app, too slow to follow a line. Here the robot runs the program and reads its sensors
  itself.
- **Learning curve.** Blockly's nested blocks are hard for kids who have never written code. The simple mode is a
  plain list of big blocks; the flowchart shows branches and loops as arrows.
- **Programs on the robot.** The stock firmware can only run a program on its own if mBlock flashes it as new
  firmware. This firmware receives programs over the link, so storing one on the robot is possible
  (not implemented yet).

## Features

- **Simple mode:** forward, turn, wait, honk; saved programs become blocks.
- **Advanced mode:** loops, conditions, sensors, variables, own blocks with inputs – shown as Blockly blocks or as
  a self-arranging flowchart (touch-friendly, undo). Both views edit the same program.
- **Live view:** the running block is highlighted; sensors, motors and variables update as the robot drives.
- **Remote control:** arrow keys, on-screen pad or a game controller; the robot stops by itself if the link drops.
- **Connections:** USB, WiFi through a [Pico W in the Bluetooth socket](docs/pico-bridge.md), or Bluetooth LE.
- **Calibration** for steps and turns (the mBot has no encoders), and a **simulator** for working without the robot.
- No cloud, no account, no build step.

## Getting started

Needs an mBot (mCore), a USB cable, Linux (macOS untested) with [uv](https://docs.astral.sh/uv/), and a browser.

```sh
tools/setup.sh                 # Arduino toolchain inside tools/ (~450 MB)
./flash.sh /dev/ttyUSB0        # Bluetooth module unplugged, see docs/flashing.md
./start.sh                     # open http://localhost:8000
```

Then run **⚙ Calibration** once with the robot on the floor.

| | |
|---|---|
| [docs/flashing.md](docs/flashing.md) | toolchain, flashing, restoring Makeblock's firmware |
| [docs/usage.md](docs/usage.md) | connecting, calibration, the modes, remote control |
| [docs/pico-bridge.md](docs/pico-bridge.md) | WiFi bridge with a Raspberry Pi Pico W |
| [docs/architecture.md](docs/architecture.md) | how it works, HTTP API, development |
| [docs/vm.md](docs/vm.md) | firmware VM: instruction set and wire protocol |

## Limitations

- Flashing needs the Bluetooth module unplugged; flashing over the air isn't possible
  ([why](docs/flashing.md#no-flashing-over-bluetooth)).
- Distances and turns are timed, so they drift as the batteries run down.
- No login: only open the server to the network (`--host 0.0.0.0`) on a network you trust.
- Not used yet: the onboard RGB LEDs and the IR receiver.

## Credits

- [Blockly](https://github.com/google/blockly) and
  [@blockly/continuous-toolbox](https://github.com/google/blockly-samples) by Google (Apache-2.0), vendored in
  `web/vendor/blockly/`.
- [Makeblock-Libraries](https://github.com/Makeblock-official/Makeblock-Libraries): the pin map and the original
  firmware in [`factory/`](factory/README.md) (CC BY-SA 3.0).
- [mCore schematic](https://github.com/Makeblock-official/mBot/blob/master/pcb/mCore.pdf).

Makeblock, mBot and mBlock are trademarks of Makeblock Co., Ltd. This project is not affiliated with or endorsed
by Makeblock, and comes with no warranty. Flashing replaces the robot's firmware;
[it can be restored](docs/flashing.md#getting-the-original-firmware-back).

## Written by an AI

The code, tests and docs were written with [Claude Code](https://claude.com/claude-code),
directed and tested on real hardware by a human. It runs well, but nobody has audited it line by line.

## License

MIT, see [LICENSE](LICENSE). Third-party parts keep their own licenses (see Credits).
