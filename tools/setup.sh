#!/usr/bin/env bash
# Set up the project-local Arduino toolchain in tools/ (nothing is installed system-wide, ~450 MB):
# arduino-cli + the AVR core, enough to build and flash firmware/mbot_vm.
#   tools/setup.sh             # toolchain only
#   tools/setup.sh --factory   # also Makeblock's library, needed only by restore_factory.sh live|default
set -euo pipefail
T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_VERSION=1.5.1
AVR_CORE=arduino:avr@1.8.8
MAKEBLOCK_COMMIT=21b20bbd55bbaaaae6ac14a4580d0a238c8bbd4d   # Makeblock-official/Makeblock-Libraries master, 2026-10-10

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)         ASSET=Linux_64bit ;;
  Linux-aarch64)        ASSET=Linux_ARM64 ;;
  Darwin-arm64)         ASSET=macOS_ARM64 ;;
  Darwin-x86_64)        ASSET=macOS_64bit ;;
  *) echo "No arduino-cli download known for $(uname -s)-$(uname -m)"; exit 1 ;;
esac

if [ ! -x "$T/bin/arduino-cli" ]; then
  mkdir -p "$T/bin"
  curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v$CLI_VERSION/arduino-cli_${CLI_VERSION}_$ASSET.tar.gz" \
    | tar -xz -C "$T/bin" arduino-cli
fi
"$T/acli" core update-index
"$T/acli" core install "$AVR_CORE"

if [ "${1:-}" = "--factory" ]; then
  LIB="$T/arduino-user/libraries/Makeblock-Libraries"
  if [ ! -d "$LIB" ]; then
    mkdir -p "$LIB"
    curl -fsSL "https://github.com/Makeblock-official/Makeblock-Libraries/archive/$MAKEBLOCK_COMMIT.tar.gz" \
      | tar -xz -C "$LIB" --strip-components=1
    # The library builds every board's driver; the MegaPi one can't compile for the mCore's ATmega328.
    rm "$LIB/src/MeMegaPi.cpp" "$LIB/src/MeMegaPi.h"
  fi
fi
echo "Toolchain ready: ./build.sh or ./flash.sh"
