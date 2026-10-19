#!/usr/bin/env python3
# /// script
# dependencies = ["pyserial"]
# ///
"""Read the whole flash of an Optiboot/STK500v1 ATmega328P into an Intel-HEX file.

Fallback for when `avrdude -U flash:r:...` loses sync (it did on the mBot's mCore).
Read-only: only sync, load-address and read-page commands are sent.

    uv run tools/read_flash.py /dev/ttyUSB0 factory/backup/mbot_flash.hex   # also writes mbot_flash.bin
"""
import sys
import time

import serial

FLASH_SIZE = 32768
CHUNK = 128


def txn(s, cmd, reply_len):
    """One STK500 command. Stray 0x00 bytes seen on the mBot's serial line are skipped."""
    for _ in range(5):
        s.reset_input_buffer()
        s.write(cmd + b"\x20")
        first = s.read(1)
        while first == b"\x00":
            first = s.read(1)
        r = first + s.read(reply_len + 1)
        if len(r) == reply_len + 2 and r[0] == 0x14 and r[-1] == 0x10:
            return r[1:-1]
    raise IOError(f"bad reply {r.hex()} for {cmd.hex()}")


def sync(s):
    for _ in range(40):
        s.reset_input_buffer()
        s.write(b"\x30\x20")
        r = s.read(2)
        if r == b"\x14\x10":
            return True
    return False


def to_hex(data, base=0):
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off:off + 16]
        rec = bytes([len(chunk), (base + off) >> 8 & 0xFF, (base + off) & 0xFF, 0]) + chunk
        lines.append(":" + (rec + bytes([(-sum(rec)) & 0xFF])).hex().upper())
    lines.append(":00000001FF")
    return "\n".join(lines) + "\n"


def main(port, out):
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.5
    s.dtr = s.rts = False
    s.open()
    time.sleep(0.1)
    s.dtr = s.rts = True      # CH340: this level change pulses RESET through the DTR capacitor
    time.sleep(0.05)
    s.dtr = s.rts = False
    time.sleep(0.05)
    if not sync(s):
        raise SystemExit("no sync with bootloader")
    time.sleep(0.1)
    s.reset_input_buffer()
    data = bytearray()
    for addr in range(0, FLASH_SIZE, CHUNK):
        w = addr // 2
        txn(s, b"\x55" + bytes([w & 0xFF, w >> 8]), 0)
        data += txn(s, b"\x74" + bytes([CHUNK >> 8, CHUNK & 0xFF]) + b"F", CHUNK)
    # leave the bootloader cleanly so the application starts again
    s.write(b"\x51\x20")
    open(out, "w").write(to_hex(bytes(data)))
    open(out.rsplit(".", 1)[0] + ".bin", "wb").write(bytes(data))
    used = len(data.rstrip(b"\xff"))
    print(f"read {len(data)} bytes, {used} used -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
