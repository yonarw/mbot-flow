#!/usr/bin/env bash
# Copy the bridge program + WiFi config to a Pico W running MicroPython and restart it.
#   ./pico_bridge/upload.sh [/dev/ttyACM1]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-auto}"
if [ ! -f wifi_config.py ]; then cp wifi_config.example.py wifi_config.py; echo "Created pico_bridge/wifi_config.py: enter your WiFi name and password, then run this again."; exit 1; fi
if grep -qE 'YOUR-WIFI|DEIN-WLAN' wifi_config.py; then echo "Enter your WiFi name and password in pico_bridge/wifi_config.py first."; exit 1; fi
uvx mpremote connect "$PORT" fs cp wifi_config.py :wifi_config.py + fs cp main.py :main.py + reset
echo "Uploaded. The LED blinks fast while joining the WiFi, slowly once it is connected."
