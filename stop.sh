#!/usr/bin/env bash
# Stop the block-programming GUI server (whatever listens on its port).   ./stop.sh [port]
# Stopping the server also tells the robot to stop driving.
PORT="${1:-8000}"
if fuser -s "$PORT/tcp" 2>/dev/null; then
  fuser -k -TERM "$PORT/tcp" >/dev/null 2>&1
  sleep 1
  fuser -s "$PORT/tcp" 2>/dev/null && fuser -k -KILL "$PORT/tcp" >/dev/null 2>&1
  echo "Server auf Port $PORT gestoppt."
else
  echo "Kein Server auf Port $PORT gefunden."
fi
