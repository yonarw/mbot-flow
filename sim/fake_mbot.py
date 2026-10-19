#!/usr/bin/env python3
"""Fake mBot running the mbot_vm protocol on a pseudo-terminal -- for testing without hardware.

    python3 sim/fake_mbot.py
    # prints e.g. "fake mBot on /dev/pts/7"; in the GUI it shows up as "Simulator"

Runs uploaded programs with the same reference VM the tests use (server/bytecode.py), in real time, in a
small made-up world so the sensors have something to say:
  * a black line: a circle of 40 cm radius that the robot starts on (at the origin, facing along it),
  * walls: a 2.8 m x 3 m box around it (for the ultrasonic sensor).
Geometry (300 mm/s at full power, 30 % dead band, 110 mm wheel base) is invented -- good for checking
that programs do the right thing, not a physics simulation.
"""
import math
import os
import sys
import threading
import time
import tty
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from bytecode import PROG_MAX, VARS_MAX, VERSION, VM, crc16, verify  # noqa: E402

FULL_SPEED_MM_S = 300.0
DEAD_BAND = 75                 # |pwm| below this doesn't move the wheels (the real robot needs ~30 %)
WHEEL_BASE_MM = 110.0
LINE_CENTER, LINE_RADIUS, LINE_HALF_WIDTH = (400.0, 0.0), 400.0, 9.0
SENSOR_AHEAD_MM, SENSOR_SPREAD_MM = 70.0, 8.0
WALLS = (-1000.0, 1800.0, -1500.0, 1500.0)      # x min, x max, y min, y max
TICK = 0.005


class Fake:
    def __init__(self, fd):
        self.fd = fd
        self.lock = threading.RLock()
        self.code, self.nvars, self.valid = b"", 0, False
        self.load_len, self.load_buf = 0, bytearray()
        self.vm = None
        self.mode = 0                      # 0 idle, 1 program, 2 remote
        self.motors = (0, 0)
        self.remote_until = 0.0
        self.tel_ms, self.tel_last, self.v_next = 50, 0.0, 0
        self.pose = [0.0, 0.0, 90.0]       # x mm, y mm, heading deg (90 = +y)
        self.t0 = time.monotonic()

    def now_ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def send(self, text):
        os.write(self.fd, (text + "\r\n").encode())

    # --- world
    def sensor(self, name):
        x, y, h = self.pose
        hx, hy = math.cos(math.radians(h)), math.sin(math.radians(h))
        if name in ("line1", "line2"):
            side = -1 if name == "line1" else 1          # +1 = right of center; line1 is the left eye (compiler.LINE_LEFT)
            sx = x + hx * SENSOR_AHEAD_MM + hy * SENSOR_SPREAD_MM * side
            sy = y + hy * SENSOR_AHEAD_MM - hx * SENSOR_SPREAD_MM * side
            d = abs(math.hypot(sx - LINE_CENTER[0], sy - LINE_CENTER[1]) - LINE_RADIUS)
            return 0 if d < LINE_HALF_WIDTH else 1        # 0 = black
        if name == "distance":
            fx, fy = x + hx * 60, y + hy * 60
            ts = []
            for lim, pos, d in ((WALLS[0], fx, hx), (WALLS[1], fx, hx), (WALLS[2], fy, hy), (WALLS[3], fy, hy)):
                if abs(d) > 1e-9 and (lim - pos) / d > 0:
                    ts.append((lim - pos) / d)
            cm = min(ts) / 10 if ts else 400
            return int(max(1, min(400, cm)))
        if name == "light":
            return 500
        return 0

    def set_motors(self, left, right):
        self.motors = (left, right)

    def physics(self, dt):
        def speed(p):
            return 0.0 if abs(p) < DEAD_BAND else p / 255 * FULL_SPEED_MM_S
        vl, vr = speed(self.motors[0]), speed(self.motors[1])
        v, w = (vl + vr) / 2, (vr - vl) / WHEEL_BASE_MM
        self.pose[2] += math.degrees(w * dt)
        self.pose[0] += math.cos(math.radians(self.pose[2])) * v * dt
        self.pose[1] += math.sin(math.radians(self.pose[2])) * v * dt

    def end(self, msg):
        self.mode = 0
        self.set_motors(0, 0)
        x, y, h = self.pose
        print(f"  {msg}  pose: x={x:.0f} mm  y={y:.0f} mm  heading={h % 360:.0f}°")
        self.send(msg)

    # --- protocol
    def handle(self, line):
        t = line.split()
        if not t:
            return
        cmd = t[0]
        try:
            if cmd == "M":
                if self.mode == 1:
                    self.vm = None
                    self.end("STOPPED")
                left, right, ttl = int(t[1]), int(t[2]), int(t[3])
                self.set_motors(max(-255, min(255, left)), max(-255, min(255, right)))
                if ttl > 0 and (left or right):
                    self.mode, self.remote_until = 2, time.monotonic() + min(ttl, 5000) / 1000
                elif self.mode == 2:
                    self.mode = 0
            elif cmd == "H":
                print(f"  horn {t[1]} Hz {t[2]} ms")
            elif cmd == "STOP":
                self.load_len = 0
                self.vm = None
                self.end("STOPPED")
            elif cmd == "PING":
                self.send(f"PONG mbot_vm {VERSION} {PROG_MAX} {VARS_MAX}")
            elif cmd == "LOAD":
                if self.mode:
                    self.vm, self.mode = None, 0
                    self.set_motors(0, 0)
                n, v = int(t[1]), int(t[2])
                if not (1 <= n <= PROG_MAX and 0 <= v <= VARS_MAX):
                    return self.send("ERR size")
                self.valid, self.load_len, self.load_buf, self.nvars = False, n, bytearray(), v
                self.send("OK")
            elif cmd == "W":
                if not self.load_len:
                    return self.send("ERR noload")
                data = bytes.fromhex(t[1])
                if len(self.load_buf) + len(data) > self.load_len:
                    self.load_len = 0
                    return self.send("ERR len")
                self.load_buf += data
                self.send("OK")
            elif cmd == "END":
                if not self.load_len or len(self.load_buf) != self.load_len:
                    self.load_len = 0
                    return self.send("ERR len")
                self.load_len = 0
                if int(t[1], 16) != crc16(self.load_buf):
                    return self.send("ERR crc")
                bad = verify(bytes(self.load_buf), self.nvars)
                if bad is not None:
                    return self.send(f"ERR verify {bad}")
                self.code, self.valid = bytes(self.load_buf), True
                print(f"  program loaded: {len(self.code)} bytes, {self.nvars} variables")
                self.send("OK")
            elif cmd == "RUN":
                if not self.valid:
                    return self.send("ERR empty")
                self.send("OK")
                self.pose = [0.0, 0.0, 90.0]
                self.vm = VM(self.code, self.nvars, sensors=self.sensor, on_motors=self.set_motors,
                             on_tone=lambda hz, ms: hz and print(f"  tone {hz} Hz {ms} ms"))
                self.vm.timer_start = self.now_ms()
                self.mode = 1
                print("  RUN (pose reset to the start of the line)")
            elif cmd == "TEL":
                self.tel_ms = max(0, min(10000, int(t[1])))
                self.send("OK")
            else:
                self.send("ERR cmd")
        except (IndexError, ValueError):
            self.send("ERR args")

    def tick(self, dt):
        now = time.monotonic()
        if self.mode == 2 and now >= self.remote_until:
            self.mode = 0
            self.set_motors(0, 0)
        if self.mode == 1 and self.vm:
            self.vm.step_until(self.now_ms(), budget=5000)
            if self.vm.state == "done":
                self.vm = None
                self.end("DONE")
            elif self.vm.state == "fault":
                fault, pc = self.vm.fault, self.vm.cur_pc
                self.vm = None
                self.mode = 0
                self.set_motors(0, 0)
                self.send(f"FAULT {fault} {pc}")
        self.physics(dt)
        if self.tel_ms and now - self.tel_last >= self.tel_ms / 1000:
            self.tel_last = now
            line = (self.sensor("line1") << 1) | self.sensor("line2")
            pc = self.vm.cur_pc if self.vm else 0
            call_pc = self.vm.call_pc if self.vm else 0
            timer = self.now_ms() - self.vm.timer_start if self.vm else 0
            self.send(f"T {self.mode} {pc} {line} {self.sensor('distance')} {self.sensor('light')} 0 "
                      f"{self.motors[0]} {self.motors[1]} {timer} {call_pc}")
            if self.vm and self.nvars:
                self.send("V 0 " + " ".join(str(v) for v in self.vm.vars))

    def run(self):
        last = time.monotonic()
        while True:
            time.sleep(TICK)
            now = time.monotonic()
            with self.lock:
                try:
                    self.tick(now - last)
                except OSError:
                    pass            # nobody has the other end open
            last = now


def main():
    sys.stdout.reconfigure(line_buffering=True)      # log lines show up at once, also when piped
    master, slave = os.openpty()
    tty.setraw(slave)                    # no echo / newline translation, like a real UART
    link = Path(__file__).resolve().parent / "tty"      # the GUI lists this as "Simulator"
    link.unlink(missing_ok=True)
    link.symlink_to(os.ttyname(slave))
    print(f"fake mBot on {os.ttyname(slave)}  (also {link})   (Ctrl+C to quit)")
    fake = Fake(master)
    threading.Thread(target=fake.run, daemon=True).start()
    fake.send(f"READY mbot_vm {VERSION}")
    buf = b""
    while True:
        try:
            data = os.read(master, 256)
        except OSError:
            time.sleep(0.2)            # nobody has the slave side open right now
            continue
        buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            with fake.lock:
                fake.handle(line.decode("ascii", "ignore").strip())


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
