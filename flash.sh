#!/usr/bin/env bash
# Compile + upload the custom firmware over USB.
# IMPORTANT: unplug the Bluetooth module from the mCore first -- while it is plugged in,
# the upload loses sync (stray bytes on the shared serial line).
#   ./flash.sh [/dev/ttyUSB0]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-/dev/ttyUSB0}"
tools/acli compile --fqbn arduino:avr:uno firmware/mbot_vm
tools/acli upload --fqbn arduino:avr:uno -p "$PORT" firmware/mbot_vm
echo "Done: firmware/mbot_vm is on the robot. It beeps once when it starts."
