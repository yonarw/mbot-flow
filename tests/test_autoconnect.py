"""Startup autoconnect: remembers the last connection, tries it 3 times, then lets the GUI ask.

    python3 -m unittest discover tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import mbot_server  # noqa: E402
from mbot_server import Robot, UserError, autoconnect, last_connection  # noqa: E402


class FakeRobot:
    """Fails `fail` times, then connects. Records what the GUI would have seen."""

    def __init__(self, fail):
        self.fail, self.calls, self.auto, self.seen, self.up = fail, [], None, [], False

    def connected(self):
        return self.up

    def connect(self, kind, target):
        self.calls.append((kind, target))
        if len(self.calls) <= self.fail:
            raise UserError(f"nope {len(self.calls)}")
        self.up = True

    def _changed(self):
        self.seen.append(dict(self.auto) if self.auto else None)


class AutoconnectTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old_settings = mbot_server.SETTINGS_FILE
        mbot_server.SETTINGS_FILE = Path(self.dir.name) / "settings.json"
        self.sleeps = []

    def tearDown(self):
        mbot_server.SETTINGS_FILE = self.old_settings
        self.dir.cleanup()

    def run_auto(self, robot, kind="wifi", target="192.168.1.50:2323"):
        return autoconnect(robot, kind, target, tries=3, pause=2, sleep=self.sleeps.append)

    def test_succeeds_on_third_try_and_remembers(self):
        robot = FakeRobot(fail=2)
        self.assertTrue(self.run_auto(robot))
        self.assertEqual(len(robot.calls), 3)
        self.assertEqual(self.sleeps, [2, 2])
        self.assertEqual([a["attempt"] for a in robot.seen if a], [1, 2, 3])
        self.assertIsNone(robot.auto)
        self.assertEqual(last_connection(), ("wifi", "192.168.1.50:2323"))

    def test_gives_up_after_three_and_reports(self):
        robot = FakeRobot(fail=99)
        self.assertFalse(self.run_auto(robot))
        self.assertEqual(len(robot.calls), 3)
        self.assertEqual(self.sleeps, [2, 2])           # no pause after the last try
        self.assertEqual(robot.auto["state"], "failed")
        self.assertEqual(robot.auto["error"], "nope 3")
        self.assertIsNone(last_connection())            # nothing remembered from a failure

    def test_stops_when_connected_from_the_gui_meanwhile(self):
        robot = FakeRobot(fail=99)
        robot.up = True
        self.assertTrue(self.run_auto(robot))
        self.assertEqual(robot.calls, [])
        self.assertIsNone(robot.auto)

    def test_real_robot_with_a_missing_port(self):
        robot = Robot()
        self.assertFalse(self.run_auto(robot, "serial", "/dev/does-not-exist"))
        self.assertEqual(robot.auto["state"], "failed")
        self.assertIn("auto", robot.state())
        self.assertFalse(robot.state()["connected"])

    def test_last_connection_ignores_junk(self):
        for content in ("", "{", json.dumps({"kind": "usb", "target": "x"}), json.dumps({"kind": "wifi"})):
            mbot_server.SETTINGS_FILE.write_text(content)
            self.assertIsNone(last_connection(), content)
        mbot_server.SETTINGS_FILE.write_text(json.dumps({"kind": "serial", "target": "/dev/ttyUSB0"}))
        self.assertEqual(last_connection(), ("serial", "/dev/ttyUSB0"))


if __name__ == "__main__":
    unittest.main()
