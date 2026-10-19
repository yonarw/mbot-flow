#!/usr/bin/env bash
# Put the original Makeblock firmware back on the mBot.
#   ./restore_factory.sh [backup|live|default] [/dev/ttyUSB0]
#
#   backup   exact byte-for-byte restore of YOUR robot's own flash dump, factory/backup/mbot_flash*.bin, made
#            before the first flash with: uv run tools/read_flash.py /dev/ttyUSB0 factory/backup/mbot_flash.hex
#            Only the app region is written; the bootloader is never touched. (Default when a dump exists.)
#   live     Makeblock's mBlock "Live mode" firmware 06.01.107, built from source (factory/mbot_firmware)
#   default  Makeblock's out-of-the-box program 06.01.009 (IR remote, line/obstacle modes), from source
#
# live/default need Makeblock's library: tools/setup.sh --factory
# Unplug the Bluetooth module first (see flash.sh). mBlock 5 -> Settings -> Update firmware also works.
set -euo pipefail
cd "$(dirname "$0")"
DUMP=$(ls factory/backup/mbot_flash*.bin 2>/dev/null | head -1 || true)
MODE="${1:-$([ -n "$DUMP" ] && echo backup || echo live)}"
PORT="${2:-/dev/ttyUSB0}"
case "$MODE" in
  backup)
    [ -n "$DUMP" ] || { echo "No flash dump in factory/backup/ (see the comment at the top of this script)."; exit 1; }
    APP=$(mktemp --suffix=.bin)
    head -c 32256 "$DUMP" > "$APP"           # 0x0000-0x7DFF; Optiboot lives at 0x7E00
    AVRDUDE_DIR=$(echo tools/arduino-data/packages/arduino/tools/avrdude/*)
    # -D: never erase the chip (that would wipe the bootloader); only the app region is written
    "$AVRDUDE_DIR/bin/avrdude" -C "$AVRDUDE_DIR/etc/avrdude.conf" -c arduino -p m328p -P "$PORT" -b 115200 -D \
      -U "flash:w:$APP:r"
    rm "$APP" ;;
  live)    tools/acli compile --fqbn arduino:avr:uno factory/mbot_firmware
           tools/acli upload  --fqbn arduino:avr:uno -p "$PORT" factory/mbot_firmware ;;
  default) tools/acli compile --fqbn arduino:avr:uno factory/mbot_factory_firmware
           tools/acli upload  --fqbn arduino:avr:uno -p "$PORT" factory/mbot_factory_firmware ;;
  *) echo "usage: $0 [backup|live|default] [port]"; exit 1 ;;
esac
echo "Restored ($MODE). Plug the Bluetooth module back in with the robot switched off."
