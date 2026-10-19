"""Saved programs: simple and advanced (Blockly) ones side by side.

    python3 -m unittest discover tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import mbot_server  # noqa: E402
from mbot_server import DEFAULT_CAL, ProgramStore, UserError  # noqa: E402

AST = {"body": [{"id": "a", "do": "wait", "sec": 1}]}


class ProgramStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = ProgramStore(Path(self.dir.name) / "programs.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_save_and_list_advanced(self):
        self.store.save("Profi", "⭐", workspace={"blocks": {}}, ast=AST)
        self.store.save("Einfach", "🚗", blocks=[{"type": "forward", "n": 1}])
        listed = {p["name"]: p for p in self.store.list(DEFAULT_CAL)}
        self.assertEqual(listed["Profi"]["kind"], "advanced")
        self.assertEqual(listed["Profi"]["blocks"], 1)
        self.assertGreater(listed["Profi"]["size"], 0)
        self.assertEqual(listed["Einfach"]["kind"], "simple")
        self.assertEqual(self.store.load("profi")["workspace"], {"blocks": {}})

    def test_unfinished_advanced_program_can_be_saved(self):
        self.store.save("Entwurf", "⭐", workspace={}, ast={"body": []})
        self.assertIsNone(self.store.list(DEFAULT_CAL)[0]["size"])

    def test_modes_dont_overwrite_each_other_and_advanced_is_no_block(self):
        self.store.save("X", "⭐", workspace={}, ast=AST)
        with self.assertRaises(UserError):
            self.store.save("x", "⭐", blocks=[{"type": "forward", "n": 1}])
        with self.assertRaises(UserError):
            self.store.save("Y", "⭐", blocks=[{"type": "program", "name": "X"}])

    def test_simple_program_compiles_through_ast(self):
        mbot_server.PROGRAMS = self.store
        self.store.save("Sub", "⭐", blocks=[{"type": "beep", "hz": 440, "sec": 0.5}])
        ast = mbot_server.blocks_to_ast([{"type": "forward", "n": 2}, {"type": "program", "name": "Sub"}],
                                        self.store.load_for_run)
        self.assertEqual([s["id"] for s in ast["body"]], ["0", "1"])
        self.assertEqual(ast["body"][1], {"id": "1", "do": "call", "name": "Sub"})
        self.assertEqual(ast["functions"]["Sub"]["body"][0]["do"], "beep")

    def test_sub_program_is_stored_once(self):
        self.store.save("Lied", "⭐", blocks=[{"type": "beep", "hz": 440, "sec": 0.5}] * 10)
        one = mbot_server.compile_ast(mbot_server.blocks_to_ast([{"type": "program", "name": "Lied"}],
                                                               self.store.load_for_run), DEFAULT_CAL)
        four = mbot_server.compile_ast(mbot_server.blocks_to_ast([{"type": "program", "name": "Lied"}] * 4,
                                                                self.store.load_for_run), DEFAULT_CAL)
        self.assertEqual(four["size"] - one["size"], 3 * 3)        # each extra use: one CALL (3 bytes)
        self.assertEqual(four["durations"]["3"], 5000)              # progress bar of the 4th block: the whole song

    def test_using_itself_is_reported_on_the_block(self):
        self.store.save("A", "⭐", blocks=[{"type": "forward", "n": 1}])
        self.store.save("B", "⭐", blocks=[{"type": "program", "name": "A"}])
        with self.assertRaises(UserError) as ctx:   # editing "A": adding B would make A use itself
            mbot_server.blocks_to_ast([{"type": "wait", "sec": 1}, {"type": "program", "name": "B"}],
                                      self.store.load_for_run, name="A")
        self.assertEqual(ctx.exception.block, "1")
        self.assertIn("benutzt sich selbst", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
