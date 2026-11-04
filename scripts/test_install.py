"""Check configuration preservation and native update exclusion."""
import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_stdio_config_preserves_unrelated_settings_and_is_idempotent(self):
        source = 'model = "example"\n\n[mcp_servers.doze-bworser-mcp]\nurl = "http://old/mcp"\n\n[mcp_servers.other]\ncommand = "other"\n'
        binary = Path('C:/User Name/bin/browser.exe')
        settings = Path('C:/User Name/config.json')
        result = installer.codex_config(source, binary, settings)
        parsed = tomllib.loads(result)
        self.assertEqual(parsed['mcp_servers']['doze-bworser-mcp']['command'], str(binary))
        self.assertEqual(parsed['mcp_servers']['other']['command'], 'other')
        self.assertNotIn('url', parsed['mcp_servers']['doze-bworser-mcp'])
        self.assertEqual(installer.codex_config(result, binary, settings), result)

    def test_update_lock_and_hook_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / 'lock'
            with installer.file_lock(lock):
                with self.assertRaises(SystemExit):
                    with installer.file_lock(lock):
                        self.fail('second owner acquired lock')
            with installer.file_lock(lock):
                pass
            codex = root / '.codex'
            codex.mkdir()
            hooks = codex / 'hooks.json'
            hooks.write_text(json.dumps({'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': 'other-tool'}]}]}}))
            installer.configure_codex(root, root, root / 'bin/doze-bworser-mcp', root / 'config.json')
            first = hooks.read_text()
            installer.configure_codex(root, root, root / 'bin/doze-bworser-mcp', root / 'config.json')
            self.assertEqual(first, hooks.read_text())
            self.assertIn('other-tool', first)
            self.assertIn(' hook', first)


if __name__ == '__main__':
    unittest.main()
