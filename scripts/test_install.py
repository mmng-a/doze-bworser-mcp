"""Verify that installing cannot interrupt active pages and restores failed switches."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        directory = Path(self.temporary.name)
        self.settings = directory / "config.json"
        self.binary = directory / "binary"
        self.built = directory / "built"
        self.plist = directory / "service.plist"
        self.paths = [self.settings, self.binary, self.plist]
        for path in self.paths:
            path.write_bytes(b"previous")
        self.built.write_bytes(b"new")

    def replace(self):
        installer.replace_service({"port": 1, "token": "test"}, self.settings,
                                  self.built, self.binary, self.plist, {})

    def test_busy_service_is_not_stopped_or_overwritten(self):
        busy = urllib.error.HTTPError("http://localhost/update", 409, "busy", {}, None)
        with patch.object(installer, "service_update", side_effect=busy), \
             patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            with self.assertRaises(SystemExit):
                self.replace()
        self.assertEqual(len(run.call_args_list), 1)
        for path in self.paths:
            self.assertEqual(path.read_bytes(), b"previous")
        self.assertFalse(self.binary.with_suffix(".new").exists())

    def test_failed_bootstrap_restores_and_resumes_previous_service(self):
        results = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
                   subprocess.CompletedProcess([], 1), subprocess.CalledProcessError(1, "bootstrap"),
                   subprocess.CompletedProcess([], 0)]
        with patch.object(installer, "service_update") as update, \
             patch.object(installer.subprocess, "run", side_effect=results):
            with self.assertRaises(subprocess.CalledProcessError):
                self.replace()
        self.assertEqual([call.args[1] for call in update.call_args_list], ["POST", "DELETE"])
        for path in self.paths:
            self.assertEqual(path.read_bytes(), b"previous")


if __name__ == "__main__":
    unittest.main()
