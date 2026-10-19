#!/usr/bin/env bash
# Start the block-programming GUI.   ./start.sh [serial:/dev/ttyUSB0 | ble:AA:BB:CC:DD:EE:FF]
# Without an argument you pick the connection in the browser. Then open http://localhost:8000
cd "$(dirname "$0")"
if [ -n "$1" ]; then exec uv run server/mbot_server.py --connect "$1"; fi
exec uv run server/mbot_server.py
