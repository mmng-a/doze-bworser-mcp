#!/usr/bin/env python3
"""Install the stdio launcher and immutable Node runtime without an OS service."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import tomllib


@contextmanager
def file_lock(path, wait=0):
    """Use the same native whole-file lock as Rust's File::try_lock."""
    with path.open('a+b') as stream:
        deadline = time.monotonic() + wait
        if os.name == 'nt':
            import ctypes
            import msvcrt
            from ctypes import wintypes
            class Overlapped(ctypes.Structure):
                _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                            ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]
            state = Overlapped()
            handle = wintypes.HANDLE(msvcrt.get_osfhandle(stream.fileno()))
            while not ctypes.windll.kernel32.LockFileEx(handle, 3, 0, 0xffffffff, 0xffffffff, ctypes.byref(state)):
                if time.monotonic() >= deadline:
                    raise SystemExit('The shared service or another installer is running.')
                time.sleep(0.05)
        else:
            import fcntl
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise SystemExit('The shared service or another installer is running.') from None
                    time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == 'nt':
                ctypes.windll.kernel32.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, ctypes.byref(state))


def prepare_runtime(root, user_dir, npm):
    sources = ['package.json', 'package-lock.json', 'daemon.mjs', 'browser.mjs',
               'controller.mjs', 'tools.mjs', 'snapshot.mjs', 'vendor/SnapshotFormatter.mjs',
               'vendor/LICENSE', 'vendor/README.md']
    digest = hashlib.sha256()
    for name in sources:
        digest.update(name.encode())
        digest.update((root / 'runtime' / name).read_bytes())
    versions = user_dir / '.local/share/doze-bworser-mcp/runtimes'
    versions.mkdir(parents=True, exist_ok=True)
    runtime = versions / digest.hexdigest()[:20]
    if not runtime.exists():
        with tempfile.TemporaryDirectory(prefix='.prepare-', dir=versions) as temporary:
            staging = Path(temporary) / 'runtime'
            for name in sources:
                destination = staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / 'runtime' / name, destination)
            subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=staging, check=True)
            staging.rename(runtime)
    return runtime


def codex_config(source, binary, settings):
    section = ('[mcp_servers.doze-bworser-mcp]\n'
               f'command = {json.dumps(str(binary))}\n'
               f'args = ["proxy", "--config", {json.dumps(str(settings))}]\n'
               'tool_timeout_sec = 90\n')
    pattern = r'(?ms)^\[mcp_servers\.doze-bworser-mcp\]\n.*?(?=^\[|\Z)'
    updated = re.sub(pattern, lambda _: section + '\n', source) if re.search(pattern, source) else source.rstrip() + '\n\n' + section
    tomllib.loads(updated)
    return updated


def write_private(path, content):
    temporary = path.with_name(path.name + '.new')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        temporary.chmod(0o600)
        stream.write(content)
    temporary.replace(path)


def configure_codex(user_dir, settings_dir, binary, settings_path):
    codex = user_dir / '.codex'
    codex.mkdir(parents=True, exist_ok=True)
    config_path = codex / 'config.toml'
    source = config_path.read_text(encoding='utf-8') if config_path.exists() else ''
    updated = codex_config(source, binary, settings_path)
    if source != updated:
        if config_path.exists():
            write_private(settings_dir / 'codex-config.before-install.toml', source)
        write_private(config_path, updated)
    hooks_path = codex / 'hooks.json'
    hooks = json.loads(hooks_path.read_text(encoding='utf-8')) if hooks_path.exists() else {'hooks': {}}
    original_hooks = json.dumps(hooks, ensure_ascii=False, indent=2) + '\n'
    for event in ['SessionStart', 'SubagentStart', 'SessionEnd']:
        entries = hooks.setdefault('hooks', {}).setdefault(event, [])
        for entry in entries:
            entry['hooks'] = [hook for hook in entry.get('hooks', []) if 'doze-bworser-mcp' not in hook.get('command', '')
                              and not (event != 'SessionEnd' and 'codex-browser hook' in hook.get('command', ''))]
        entries[:] = [entry for entry in entries if entry.get('hooks')]
        # Codex invokes command hooks through the host shell.
        import shlex
        command = subprocess.list2cmdline([str(binary), 'hook']) if os.name == 'nt' else shlex.join([str(binary), 'hook'])
        entries.append({'hooks': [{'type': 'command', 'command': command, 'timeout': 15,
                                  **({'additionalContextLimit': 400} if event == 'SessionStart' else {})}]})
    serialized = json.dumps(hooks, ensure_ascii=False, indent=2) + '\n'
    if serialized != original_hooks:
        if hooks_path.exists():
            write_private(settings_dir / 'codex-hooks.before-install.json', original_hooks)
        write_private(hooks_path, serialized)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', type=Path, help='Dedicated Chrome for Testing executable')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    user_dir = Path.home()
    executable = 'doze-bworser-mcp' + ('.exe' if os.name == 'nt' else '')
    built = root / 'target/release' / executable
    if not built.is_file():
        raise SystemExit('Run cargo build --release --locked first.')
    settings_dir = user_dir / '.config/doze-bworser-mcp'
    settings_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_dir.chmod(0o700)
    settings_path = settings_dir / 'config.json'
    with file_lock(settings_dir / 'install.lock'):
        previous = json.loads(settings_path.read_text(encoding='utf-8')) if settings_path.exists() else {}
        if 'port' in previous:
            raise SystemExit('Stop and remove the old OS service before migrating; this installer never manages OS services. Remove port from config.json after stopping it.')
        chrome = args.chrome or (Path(previous['chrome_path']) if 'chrome_path' in previous else None)
        if chrome is None or not chrome.is_file():
            raise SystemExit('Pass --chrome with a dedicated Chrome for Testing executable.')
        node, npm = shutil.which('node'), shutil.which('npm')
        if not node or not npm:
            raise SystemExit('Install Node.js and npm first.')
        runtime = prepare_runtime(root, user_dir, npm)
        token = previous.get('token', secrets.token_hex(32))
        if os.name == 'nt':
            socket = '\\\\.\\pipe\\doze-bworser-' + token[:24]
        else:
            socket_dir = Path('/tmp') / ('doze-bworser-' + token[:24])
            socket_dir.mkdir(mode=0o700, exist_ok=True)
            if socket_dir.is_symlink() or socket_dir.stat().st_uid != os.getuid():
                raise SystemExit('IPC directory must belong to this OS user and must not be a symlink.')
            socket_dir.chmod(0o700)
            socket = str(socket_dir / 'ipc.sock')
        settings = dict(token=token, socket_path=socket, chrome_path=str(chrome.resolve()), node_path=node,
                        daemon_path=str(runtime / 'daemon.mjs'), operation_timeout_seconds=20)
        binary = user_dir / '.local/bin' / executable
        binary.parent.mkdir(parents=True, exist_ok=True)
        if previous and binary.exists():
            subprocess.run([str(binary), 'stop', '--config', str(settings_path)], capture_output=True)
        with file_lock(settings_dir / 'service.lock', wait=5):
            pending = binary.with_name(binary.name + '.new')
            shutil.copy2(built, pending)
            pending.chmod(0o755)
            pending.replace(binary)
            write_private(settings_path, json.dumps(settings, indent=2) + '\n')
            configure_codex(user_dir, settings_dir, binary, settings_path)
    print(f'Installed stdio MCP launcher: {binary}')
    print('No login service is registered. Node starts on connection; Chromium starts on open_page.')
    print('Reload the MCP configuration in existing Codex threads. Changed hooks may need trust in /hooks.')


if __name__ == '__main__':
    main()
