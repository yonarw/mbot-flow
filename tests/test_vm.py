"""Compiler + reference VM tests, and a check that the firmware's opcode table matches bytecode.py.

    python3 -m unittest discover tests
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from bytecode import OPS, SENSORS, VM, Assembler, Label, op_len, verify  # noqa: E402
from compiler import CompileError, compile_program, owner_at  # noqa: E402

CAL = {"speed": 50, "turn_speed": 50, "forward_ms": 1000, "turn_left_ms": 500, "turn_right_ms": 500,
       "trim": 0, "settle_ms": 100, "reverse": False}


def run(body, sensors=None, until=60000, cal=CAL):
    """Compile and run in virtual time (1 ms steps). Returns (vm, motor log [(t, l, r)], tones)."""
    result = compile_program({"body": body}, cal)
    log, tones = [], []
    t = [0]
    vm = VM(result["code"], result["nvars"], sensors=(lambda n: sensors(n, t[0])) if sensors else None,
            on_motors=lambda l, r: log.append((t[0], l, r)), on_tone=lambda hz, ms: tones.append((t[0], hz, ms)))
    while vm.state == "running" and t[0] < until:
        vm.step_until(t[0], budget=64)       # like the firmware: a slice per pass
        t[0] += 1
    return vm, log, tones, result


def num(v):
    return {"op": "num", "value": v}


def var(n):
    return {"op": "var", "name": n}


def bin_(fn, a, b):
    return {"op": "bin", "fn": fn, "a": a, "b": b}


class CompilerTests(unittest.TestCase):
    def test_timed_move_and_settle(self):
        vm, log, _, _ = run([{"id": "a", "do": "move", "dir": "forward", "steps": 2}])
        self.assertEqual(vm.state, "done")
        self.assertEqual(log[0], (0, 127, 127))          # 50 % -> round(127.499..) = 127
        self.assertEqual(log[1][1:], (0, 0))
        self.assertEqual(log[1][0], 2000)

    def test_long_move_is_split_without_stopping(self):
        vm, log, _, r = run([{"id": "a", "do": "move", "dir": "forward", "steps": 50}],
                            cal={**CAL, "forward_ms": 5000}, until=400000)
        self.assertEqual(vm.state, "done")
        stops = [e for e in log if e[1:] == (0, 0)]
        self.assertEqual(len(stops), 2)                  # the end of the move, then HALT
        self.assertEqual(stops[0][0], 250000)

    def test_reverse_swaps_and_negates(self):
        _, log, _, _ = run([{"id": "a", "do": "turn", "dir": "left", "deg": 90}], cal={**CAL, "reverse": True})
        self.assertEqual(log[0][1:], (-127, 127))         # left turn: (-v, v) -> reversed (-v, v) again
        _, log, _, _ = run([{"id": "a", "do": "drive", "dir": "forward", "power": 40}], cal={**CAL, "reverse": True})
        self.assertEqual(log[0][1:], (-102, -102))

    def test_repeat_and_variables(self):
        vm, _, _, r = run([
            {"id": "a", "do": "set", "var": "n", "value": 5},
            {"id": "b", "do": "repeat", "times": 3, "body": [{"id": "c", "do": "change", "var": "n", "by": 2}]},
            {"id": "d", "do": "repeat", "times": var("n"), "body": [{"id": "e", "do": "change", "var": "k", "by": 1}]},
            {"id": "f", "do": "set", "var": "z", "value": 0},
            {"id": "g", "do": "repeat", "times": var("z"), "body": [{"id": "h", "do": "change", "var": "k", "by": 100}]},
        ])
        self.assertEqual(vm.state, "done")
        self.assertEqual(r["vars"], ["n", "k", "z"])
        self.assertEqual(vm.vars[:3], [11, 11, 0])

    def test_nested_repeat_counters_are_separate(self):
        vm, _, _, _ = run([{"id": "a", "do": "repeat", "times": 3, "body": [
            {"id": "b", "do": "repeat", "times": 4, "body": [{"id": "c", "do": "change", "var": "n", "by": 1}]}]}])
        self.assertEqual(vm.vars[0], 12)

    def test_integer_semantics_match_c(self):
        vm, _, _, r = run([
            {"id": "x", "do": "set", "var": "two", "value": 2},
            {"id": "a", "do": "set", "var": "a", "value": bin_("/", num(-7), var("two"))},
            {"id": "b", "do": "set", "var": "b", "value": bin_("%", num(-7), var("two"))},
            {"id": "c", "do": "set", "var": "c", "value": bin_("/", num(5), var("zero"))},
            {"id": "d", "do": "set", "var": "d", "value": bin_("%", num(-7), num(2))},      # folded by the compiler
        ])
        got = dict(zip(r["vars"], vm.vars))
        self.assertEqual((got["a"], got["b"], got["c"], got["d"]), (-3, -1, 0, -1))   # C: truncate toward zero; x/0 = 0

    def test_wait_until_sensor_then_stop(self):
        def sensors(name, t):
            return max(1, 100 - t // 20) if name == "distance" else 1     # an obstacle comes closer
        vm, log, _, _ = run([
            {"id": "a", "do": "drive", "dir": "forward", "power": 50},
            {"id": "b", "do": "wait_until", "cond": bin_("<", {"op": "sensor", "name": "distance"}, num(10))},
            {"id": "c", "do": "stop"},
        ], sensors)
        self.assertEqual(vm.state, "done")
        self.assertEqual(log[1], (1820, 0, 0))           # 100 - t//20 < 10 first at t = 1820

    def test_line_follower_branches(self):
        # left sensor (line1) over black -> steer left; the compiler maps line_left to "black" = raw 0
        def sensors(name, t):
            return {"line1": 0, "line2": 1}.get(name, 0)
        vm, log, _, _ = run([{"id": "f", "do": "forever", "body": [
            {"id": "i", "do": "if", "cond": {"op": "sensor", "name": "line_left"},
             "then": [{"id": "l", "do": "motors", "left": 20, "right": 60}],
             "else": [{"id": "r", "do": "motors", "left": 60, "right": 20}]},
            {"id": "w", "do": "wait", "sec": 0.01}]}], sensors, until=100)
        self.assertEqual(vm.state, "running")
        self.assertEqual(log[0][1:], (51, 153))

    def test_beep_with_wait_and_expression_seconds(self):
        vm, _, tones, _ = run([
            {"id": "a", "do": "set", "var": "s", "value": 2},
            {"id": "b", "do": "beep", "hz": 440, "sec": var("s"), "wait": True},
            {"id": "c", "do": "beep", "hz": 880, "sec": 0.25, "wait": False},
        ])
        self.assertEqual(tones[0], (0, 440, 2000))
        self.assertEqual(tones[1], (2000, 880, 250))

    def test_owners_map_pc_to_innermost_block(self):
        r = compile_program({"body": [{"id": "loop", "do": "repeat", "times": 2, "body": [
            {"id": "inner", "do": "wait", "sec": 1}]}]}, CAL)
        wait_pc = next(pc for pc, owner in r["owners"] if owner == "inner")
        self.assertEqual(owner_at(r["owners"], wait_pc + 3), "inner")
        loop_pcs = [pc for pc, owner in r["owners"] if owner == "loop"]
        self.assertTrue(loop_pcs)
        self.assertEqual(r["durations"], {"inner": 1000})

    def test_errors(self):
        with self.assertRaises(CompileError):
            compile_program({"body": []}, CAL)
        with self.assertRaises(CompileError):
            compile_program({"body": [{"do": "wait", "sec": None}]}, CAL)
        with self.assertRaises(CompileError):
            compile_program({"body": [{"do": "set", "var": f"v{i}", "value": 1} for i in range(17)]}, CAL)
        with self.assertRaises(CompileError):     # too big for 768 bytes
            compile_program({"body": [{"do": "move", "dir": "forward", "steps": 1}] * 100}, CAL)

    def test_verify_rejects_bad_jump_and_var(self):
        asm = Assembler()
        asm.emit("JMP", 1)
        asm.emit("HALT")
        code, _ = asm.assemble()
        self.assertEqual(verify(code, 0), 0)
        asm = Assembler()
        asm.emit("LOAD", 3)
        code, _ = asm.assemble()
        self.assertEqual(verify(code, 2), 0)
        asm = Assembler()
        end = Label()
        asm.emit("JMP", end)
        asm.label(end)
        asm.emit("HALT")
        code, _ = asm.assemble()
        self.assertIsNone(verify(code, 0))

    def test_stack_overflow_faults(self):
        asm = Assembler()
        for _ in range(17):
            asm.push(1)
        code, _ = asm.assemble()
        vm = VM(code, 0)
        vm.step_until(0)
        self.assertEqual((vm.state, vm.fault), ("fault", 1))


class FunctionTests(unittest.TestCase):
    def compile(self, body, functions):
        return compile_program({"body": body, "functions": functions}, CAL)

    def run_fn(self, body, functions, until=60000):
        r = self.compile(body, functions)
        vm, t = VM(r["code"], r["nvars"]), 0
        while vm.state == "running" and t < until:
            vm.step_until(t, budget=64)
            t += 1
        return vm, r

    def test_call_with_parameters_and_own_loop_counter(self):
        # main: repeat 3 { zick(2) } -- zick has its own repeat: the counters must not collide
        fns = {"zick": {"params": ["n"], "id": "def", "body": [
            {"id": "r", "do": "repeat", "times": var("n"), "body": [{"id": "c", "do": "change", "var": "k", "by": 1}]}]}}
        vm, r = self.run_fn([{"id": "m", "do": "repeat", "times": 3, "body": [
            {"id": "call", "do": "call", "name": "zick", "args": [num(2)]}]}], fns)
        self.assertEqual(vm.state, "done")
        self.assertEqual(dict(zip(r["vars"], vm.vars))["k"], 6)

    def test_parameter_hides_global_variable(self):
        fns = {"f": {"params": ["x"], "body": [{"id": "s", "do": "set", "var": "y", "value": var("x")}]}}
        vm, r = self.run_fn([{"id": "a", "do": "set", "var": "x", "value": 1},
                             {"id": "b", "do": "call", "name": "f", "args": [num(7)]}], fns)
        got = dict(zip(r["vars"], vm.vars))
        self.assertEqual((got["x"], got["y"]), (1, 7))

    def test_unused_function_costs_nothing(self):
        body = [{"id": "a", "do": "wait", "sec": 1}]
        self.assertEqual(self.compile(body, {"f": {"params": [], "body": body}})["size"],
                         self.compile(body, {})["size"])

    def test_recursion_is_an_error_on_the_definition(self):
        fns = {"a": {"params": [], "id": "defA", "body": [{"id": "x", "do": "call", "name": "b"}]},
               "b": {"params": [], "id": "defB", "body": [{"id": "y", "do": "call", "name": "a"}]}}
        with self.assertRaises(CompileError) as ctx:
            self.compile([{"id": "m", "do": "call", "name": "a"}], fns)
        self.assertIn(ctx.exception.block, ("defA", "defB"))

    def test_call_depth_limit(self):
        fns = {f"f{i}": {"params": [], "body": [{"do": "call", "name": f"f{i + 1}"}]} for i in range(9)}
        fns["f9"] = {"params": [], "body": [{"do": "wait", "sec": 0.1}]}
        with self.assertRaises(CompileError):
            self.compile([{"do": "call", "name": "f0"}], fns)
        vm, _ = self.run_fn([{"do": "call", "name": "f2"}], fns)      # depth 8: fits
        self.assertEqual(vm.state, "done")

    def test_call_pc_points_at_the_outer_call(self):
        fns = {"f": {"params": [], "body": [{"id": "w", "do": "wait", "sec": 1}]}}
        r = self.compile([{"id": "top", "do": "call", "name": "f"}], fns)
        vm = VM(r["code"], r["nvars"])
        vm.step_until(0)
        self.assertEqual(owner_at(r["owners"], vm.cur_pc), "w")
        self.assertEqual(owner_at(r["owners"], vm.call_pc), "top")

    def test_constant_beep_is_one_note(self):
        r = compile_program({"body": [{"id": "b", "do": "beep", "hz": 440, "sec": 0.5, "wait": True}]}, CAL)
        self.assertEqual(r["size"], 6)                    # NOTE (5) + HALT
        self.assertEqual(r["durations"], {"b": 500})

    def test_error_names_the_block(self):
        with self.assertRaises(CompileError) as ctx:
            compile_program({"body": [{"id": "outer", "do": "repeat", "times": 2, "body": [
                {"id": "inner", "do": "wait", "sec": None}]}]}, CAL)
        self.assertEqual(ctx.exception.block, "inner")


class FirmwareTableTests(unittest.TestCase):
    """The firmware's opcode numbers, lengths and sensor ids must match bytecode.py."""

    def setUp(self):
        self.src = (ROOT / "firmware" / "mbot_vm" / "mbot_vm.ino").read_text()

    def enum(self, first):
        body = re.search(r"enum : uint8_t \{\s*(" + first + r"[^}]*)\}", self.src).group(1)
        out, value = {}, -1
        for item in body.replace("\n", " ").split(","):
            item = item.split("//")[0].strip()
            if not item:
                continue
            name, _, explicit = item.partition("=")
            value = int(explicit.strip(), 0) if explicit.strip() else value + 1
            out[name.strip()] = value
        return out

    def test_opcodes_and_lengths(self):
        ops = self.enum("OP_HALT")
        table = re.search(r"OP_LEN\[OP_COUNT\] PROGMEM = \{(.*?)\};", self.src, re.S).group(1)
        lens = [int(n) for n in re.findall(r"\b\d+\b", re.sub(r"//[^\n]*", "", table))]
        for name, (code, _) in OPS.items():
            self.assertEqual(ops.get("OP_" + name), code, name)
            self.assertEqual(lens[code], op_len(name), name)
        self.assertEqual(sum(1 for n in lens if n), len(OPS))

    def test_sensor_ids(self):
        ids = self.enum("S_LINE")
        for name, sid in SENSORS.items():
            self.assertEqual(ids["S_" + name.upper()], sid, name)


if __name__ == "__main__":
    unittest.main()
