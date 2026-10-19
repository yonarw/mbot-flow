#!/usr/bin/env bash
# Compile the custom firmware (no upload).
set -euo pipefail
cd "$(dirname "$0")"
tools/acli compile --fqbn arduino:avr:uno --warnings default firmware/mbot_vm "$@"
