# Flashing the firmware

mbot-flow needs its own firmware on the mBot ([`firmware/mbot_vm`](../firmware/mbot_vm/mbot_vm.ino)). It
replaces Makeblock's firmware, so mBlock stops working until you [restore it](#getting-the-original-firmware-back).
Calibration lives on the PC, so you rarely need to reflash.

## 1. Toolchain

```sh
tools/setup.sh              # arduino-cli 1.5.1 + AVR core 1.8.8, all inside tools/ (~450 MB, nothing system-wide)
tools/setup.sh --factory    # also Makeblock's library – only needed to rebuild the original firmware
```

`tools/acli` is arduino-cli with all its state kept in `tools/`.

## 2. Unplug the Bluetooth module ⚠

With the Bluetooth/BLE module on the mCore, the upload (and even reading the flash) loses sync after ~0.85 s.
Switch off, unplug USB, pull the module (the case is screwed, not sealed), plug USB in, switch on, flash, then
put the module back **with the robot switched off**. With the [Pico W bridge](../pico_bridge/wiring.html) in
the socket instead, it's enough to pull the wire on P5 pin 3.

Why (from the [mCore schematic](https://github.com/Makeblock-official/mBot/blob/master/pcb/mCore.pdf)): the USB
chip can only pull the shared RX line low (diode D7 + 10 kΩ pull-up R13), while the module's TX drives the same
line directly – with the module in, the PC's data gets garbled.

## 3. Back up the original firmware (optional, once)

```sh
uv run tools/read_flash.py /dev/ttyUSB0 factory/backup/mbot_flash.hex    # also writes mbot_flash.bin
```

A read-only dump of the whole flash, so `./restore_factory.sh` can later put back exactly what was on your
robot. It talks to the bootloader directly, because `avrdude -U flash:r:…` lost sync on the mCore.

## 4. Flash

```sh
./build.sh                      # compile only
./flash.sh [/dev/ttyUSB0]       # compile + upload; the robot beeps briefly when it starts
```

## No flashing over Bluetooth

Not possible by software alone: the bootloader is Optiboot 4.4, which only stays active after an *external*
reset (`sbrs r24, EXTRF` at 0x7E06). Tested: a firmware command that sets that flag and jumps to 0x7E00 bounces
straight back into the app – the flag doesn't stick. The board has a header P4 (RST / GND / EX_DTR) through
which a radio module could reset the processor; whether Makeblock's BLE module uses it is untested. That's why
the firmware is a generic VM whose programs come from the PC, and everything tunable lives on the PC.

## Getting the original firmware back

```sh
./restore_factory.sh            # your own dump from step 3 if there is one, else "live"
./restore_factory.sh backup     # byte-for-byte your dump (the bootloader is never touched)
./restore_factory.sh live       # Makeblock 06.01.107 ("Live mode" for mBlock), built from source
./restore_factory.sh default    # Makeblock's out-of-the-box program 06.01.009 (IR remote, line/obstacle modes)
```

`live` and `default` need `tools/setup.sh --factory`. The sources are in [`factory/`](../factory/README.md).
Alternatively: mBlock 5 → Devices → Settings → Update firmware. The unplug-the-Bluetooth-module rule applies
here too.

## Pins

From Makeblock's `MeMCore.h`: M1 PWM 6 / DIR 7, M2 PWM 5 / DIR 4, buzzer 8, line follower on port 2 (D9, D10),
ultrasonic on port 3 (A3), light sensor A6, button A7.

M1 is the right wheel and M2 the left one (seen from behind, facing where the face looks), so the firmware
drives `M1 = +right, M2 = -left`. That is the opposite of Makeblock's own `Forward()`, which drives the robot
away from its face.
