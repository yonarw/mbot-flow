# Flashing

The firmware ([`firmware/mbot_vm`](../firmware/mbot_vm/mbot_vm.ino)) replaces Makeblock's, so mBlock stops working
until you [restore it](#getting-the-original-firmware-back). Calibration lives on the PC; reflashing is rarely
needed.

## 1. Toolchain

```sh
tools/setup.sh              # arduino-cli + AVR core, inside tools/ (~450 MB, nothing system-wide)
tools/setup.sh --factory    # also Makeblock's library, only needed to rebuild the original firmware
```

## 2. Unplug the Bluetooth module

With the module on the mCore, uploads lose sync after ~0.85 s. Robot off, USB out, pull the module, USB in, robot
on, flash; put the module back with the robot off. With the [Pico W bridge](pico-bridge.md) in the socket, pull
the wire on P5 pin 3 instead.

Why ([mCore schematic](https://github.com/Makeblock-official/mBot/blob/master/pcb/mCore.pdf)): the USB chip can
only pull the shared RX line low (diode D7, 10 kΩ pull-up R13), while the module's TX drives it directly.

## 3. Back up the original firmware (optional, once)

```sh
uv run tools/read_flash.py /dev/ttyUSB0 factory/backup/mbot_flash.hex    # also writes mbot_flash.bin
```

A read-only dump for an exact restore later. It talks to the bootloader directly because
`avrdude -U flash:r:…` loses sync on the mCore.

## 4. Flash

```sh
./build.sh                  # compile only
./flash.sh [/dev/ttyUSB0]   # compile + upload; the robot beeps when it starts
```

## No flashing over Bluetooth

The bootloader (Optiboot 4.4) only stays active after an external reset (`sbrs r24, EXTRF` at 0x7E06); a firmware
command that sets the flag and jumps to 0x7E00 bounces straight back into the app. Header P4 (RST / GND / EX_DTR)
could let a radio module reset the chip, but Makeblock's module isn't known to use it. Hence a generic VM firmware
that gets its programs over the link.

## Getting the original firmware back

```sh
./restore_factory.sh            # your dump from step 3 if there is one, else "live"
./restore_factory.sh backup     # your dump, byte for byte (the bootloader is never touched)
./restore_factory.sh live       # Makeblock 06.01.107 (mBlock live mode), built from source
./restore_factory.sh default    # Makeblock 06.01.009, the out-of-the-box program
```

`live` and `default` need `tools/setup.sh --factory`; sources in [`factory/`](../factory/README.md). mBlock 5 →
Devices → Settings → Update firmware works too. Unplug the Bluetooth module here as well.

## Pins

From Makeblock's `MeMCore.h`: M1 PWM 6 / DIR 7, M2 PWM 5 / DIR 4, buzzer 8, line follower port 2 (D9, D10),
ultrasonic port 3 (A3), light sensor A6, button A7. M1 is the right wheel, M2 the left (seen from behind), so the
firmware drives `M1 = +right, M2 = -left` – the opposite of Makeblock's `Forward()`.
