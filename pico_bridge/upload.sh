#!/usr/bin/env bash
# Copy the bridge program + WiFi config to a Pico W running MicroPython and restart it.
#   ./pico_bridge/upload.sh [/dev/ttyACM1]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-auto}"
if [ ! -f wifi_config.py ]; then cp wifi_config.example.py wifi_config.py; echo "pico_bridge/wifi_config.py angelegt: WLAN-Name und Passwort eintragen, dann noch einmal starten."; exit 1; fi
if grep -q 'DEIN-WLAN' wifi_config.py; then echo "Erst WLAN-Name und Passwort in pico_bridge/wifi_config.py eintragen."; exit 1; fi
uvx mpremote connect "$PORT" fs cp wifi_config.py :wifi_config.py + fs cp main.py :main.py + reset
echo "Hochgeladen. Die LED blinkt schnell beim Verbinden, langsam sobald das WLAN steht."
