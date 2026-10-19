# mbot_vm – bytecode VM firmware (version 2)

The server compiles a block program into compact bytecode, uploads it once, and the mBot runs it on its
own. Sensors are read on the board, so "drive until the line is lost" reacts within microseconds, not a
WiFi/BLE round trip. The robot streams telemetry (where it is in the program, sensors, motors, variables)
that the GUI shows live – but telemetry is best effort and can never slow the program down.

```
 web/ (simple blocks | Blockly)  ──AST──►  server/compiler.py  ──bytecode──►  firmware/mbot_vm
                                           server/bytecode.py                  runs it, sends T/V lines
         ◄──────── SSE: block highlight, sensors, variables ────────  server  ◄─────────┘
```

Source of truth for opcodes and the wire format: [`server/bytecode.py`](../server/bytecode.py). The firmware
([`firmware/mbot_vm/mbot_vm.ino`](../firmware/mbot_vm/mbot_vm.ino)) and the simulator
([`sim/fake_mbot.py`](../sim/fake_mbot.py), which runs the very same Python VM as the tests) mirror it.

## Machine model

* **Values:** 32-bit signed integers. Literals are encoded in 1, 2 or 4 bytes. Division by zero gives 0
  (a kids' program shouldn't crash on it).
* **Stack:** 16 entries, for expressions. Overflow/underflow is a runtime fault.
* **Calls:** functions (saved programs used as blocks, Profi "Meine Blöcke") are compiled once and called;
  return stack of 8. The compiler refuses recursion and deeper nesting, so the runtime check is only a
  safety net. Parameters are hidden variables the call sets – possible because there is no recursion.
* **Variables:** up to 16, all 0 when a program starts. The compiler assigns the slots.
* **Program:** up to 768 bytes in RAM, verified on upload (valid opcodes, operands inside the program,
  jumps land on instruction starts, variable slots exist), so the interpreter needs no bounds checks.
* **Scheduling:** no `delay()` anywhere. `WAIT` / `MOVE` set a wake-up time and the VM yields. Otherwise it
  runs 64 instructions per `loop()` pass, then serial input, telemetry, the ultrasonic sensor and the
  remote-control deadman get their turn (well under 1 ms per pass). A busy `forever` loop is fine.
* **Sensors:** line follower read live (`digitalRead`); light and button sampled every 5 ms in the
  background (`analogRead` is slow); ultrasonic measured every 30 ms by a pin-change interrupt, never by
  blocking `pulseIn()`.

## Instructions

| Op | Hex | Operands | Stack | Meaning |
|---|---|---|---|---|
| `HALT` | 00 | | | program ends, motors and buzzer off, sends `DONE` |
| `PUSH8/16/32` | 01–03 | i8 / i16 / i32 | → v | literal |
| `LOAD` / `STORE` | 04 / 05 | var u8 | → v / v → | variable |
| `DROP` | 06 | | v → | |
| `ADD SUB MUL DIV MOD` | 10–14 | | a b → r | |
| `NEG` | 15 | | a → −a | |
| `EQ NE LT LE GT GE` | 18–1D | | a b → 0/1 | |
| `AND OR` / `NOT` | 1E 1F / 20 | | logical, 0/1 | |
| `RAND` | 21 | | lo hi → r | random integer lo..hi |
| `JMP` / `JZ` / `JNZ` | 28–2A | addr u16 | – / v → | jump (if zero / not zero) |
| `LOOP` | 2B | var u8, addr u16 | | var −= 1; jump if var > 0 (counted repeat) |
| `CALL` / `RET` | 2C / 2D | addr u16 / – | | call a function (return address on the return stack) / return |
| `SENS` | 30 | sensor u8 | → v | read a sensor, see below |
| `MOTORS` | 31 | | left right → | set wheel power −255..255 (+ = forward) and keep driving |
| `WAIT` | 32 | | ms → | sleep |
| `TONE` | 33 | | hz ms → | start a tone and continue (0 = off) |
| `TRESET` | 34 | | | timer sensor back to 0 |
| `MOVE` | 38 | left i16, right i16, ms u16, pause u8 | | timed drive: motors, sleep `ms`, motors off, sleep `pause`×10 ms. `pause` 255 = keep driving (long moves split in parts) |

| `NOTE` | 39 | hz u16, ms u16 | | play a tone and wait until it's over |

`MOVE` is the compact form of "Vorwärts 2 Schritte" etc. (8 bytes; the generic form would be ~19), `NOTE` of
"Hupen" (5 bytes instead of 11).

Sensors: 0 line follower raw (bit1 = sensor 1 on D9, bit0 = sensor 2 on D10; 1 = white), 1 / 2 the single
line sensors, 3 distance cm (1–400, 400 = nothing in range), 4 light 0–1023, 5 button 0/1, 6 timer ms,
7 / 8 current left / right motor power.

## Wire protocol (ASCII lines, 115200 baud, `\n`)

ASCII only on the wire; the program itself is stored as binary on the board, so debugging comfort costs
nothing at run time. A disassembly is available from the server (`POST /api/compile`).

| PC → mBot | Reply | |
|---|---|---|
| `PING` | `PONG mbot_vm <ver> <prog_max> <vars_max>` | the server refuses a firmware whose `<ver>` isn't its own |
| `LOAD <len> <nvars>` | `OK` / `ERR size` | stops a running program, starts an upload |
| `W <hex>` | `OK` / `ERR …` | next ≤ 24 program bytes |
| `END <crc16>` | `OK` / `ERR crc` / `ERR verify <pc>` | CRC-16/CCITT-FALSE as 4 hex digits |
| `RUN` | `OK` / `ERR empty` | start at 0, variables and timer reset |
| `STOP` | `STOPPED` | always works, also mid-program and mid-upload |
| `M <left> <right> <ttl_ms>` | – | remote control: drive now, stop by itself after ttl unless renewed. Stops a running program (sends `STOPPED` then). |
| `H <hz> <ms>` | – | horn; doesn't touch the motors or a running program |
| `TEL <ms>` | `OK` | telemetry period, 0 = off (default 50) |

Unsolicited, from the robot:

* `READY mbot_vm <ver>` after reset
* `T <mode> <pc> <line> <dist> <light> <button> <left> <right> <timer> <call_pc>` – mode 0 idle, 1 program,
  2 remote. `pc` is the instruction the program is in (the one it's waiting on, while it waits); `call_pc` the
  outermost `CALL` it is inside (= `pc` outside functions) – the simple mode highlights that block.
* `V <v0> <v1> …` – variables, right after `T`, when the program has any.
* `DONE`, `STOPPED`, `FAULT <code> <pc>` (1 stack overflow, 2 stack underflow, 3 calls too deep, 4 `RET`
  without call).

**Telemetry never blocks.** All output goes through a 160-byte queue that is drained into the UART only as
far as its send buffer has room. A `T`/`V` line is only queued if it fits completely; otherwise that sample
is skipped – the next one is newer anyway. Replies are short and always fit.

## Open points

* Verified on the robot: version 2 (CALL/RET/NOTE) runs; line sensor 1 (D9) is the left eye (`LINE_LEFT` in `server/compiler.py`). Still to
  check: ultrasonic on port 3, button threshold.
* EEPROM (100k write cycles per cell, so saving a program now and then is harmless): store the program to
  start it with the onboard button, without a PC.
* Parallel scripts / events ("when obstacle"), LEDs (WS2812 on D13), IR receiver.
