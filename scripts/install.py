#!/usr/bin/env python3
"""Install the built local service and register its HTTP MCP and lifecycle hooks."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import subprocess
import tomllib
import tempfile
import time
import urllib.error
import urllib.request


def prepare_runtime(root, user_dir, npm):
    sources = ["package.json", "package-lock.json", "worker.mjs", "snapshot.mjs",
               "vendor/SnapshotFormatter.mjs", "vendor/LICENSE", "vendor/README.md"]
    digest = hashlib.sha256()
    for name in sources:
        digest.update(name.encode())
        digest.update((root / "runtime" / name).read_bytes())
    versions = user_dir / ".local/share/doze-bworser-mcp/runtimes"
    versions.mkdir(parents=True, exist_ok=True)
    runtime = versions / digest.hexdigest()[:20]
    if not runtime.exists():
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=versions) as temporary:
            staging = Path(temporary) / "runtime"
            for name in sources:
                destination = staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / "runtime" / name, destination)
            subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                           cwd=staging, check=True)
            staging.rename(runtime)
    return runtime


def service_update(settings, method):
    request = urllib.request.Request(
        f'http://127.0.0.1:{settings["port"]}/update', method=method,
        headers={"Authorization": "Bearer " + settings["token"]},
    )
    with urllib.request.urlopen(request, timeout=35):
        pass


def replace_service(settings, settings_path, built, binary, plist, plist_data):
    label = "com.masasam.doze-bworser-mcp"
    domain = f"gui/{os.getuid()}"
    target = f"{domain}/{label}"
    backups = {path: path.read_bytes() if path.exists() else None
               for path in [settings_path, binary, plist]}
    pending = binary.with_suffix(".new")
    shutil.copy2(built, pending)
    pending.chmod(0o755)
    running = subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0
    paused = False
    stopped = False
    try:
        if running:
            try:
                service_update(settings, "POST")
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    raise SystemExit("The installed service predates safe updates; migrate it before running this installer.") from error
                raise SystemExit("The service is busy or updating; installation left it unchanged.") from error
            paused = True
        if running:
            subprocess.run(["launchctl", "bootout", target], check=True, capture_output=True)
            stopped = True
            deadline = time.monotonic() + 10
            while subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0:
                if time.monotonic() >= deadline:
                    raise RuntimeError("The previous service is still stopping")
                time.sleep(0.1)
        pending.replace(binary)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
        settings_path.chmod(0o600)
        plist.write_bytes(plistlib.dumps(plist_data))
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    except BaseException:
        if stopped:
            for path, contents in backups.items():
                if contents is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(contents)
            if backups[binary] is not None:
                binary.chmod(0o755)
            if backups[plist] is not None:
                subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=False)
        if paused:
            service_update(settings, "DELETE")
        raise
    finally:
        pending.unlink(missing_ok=True)


def main():
    root = Path(__file__).resolve().parents[1]
    user_dir = Path.home()
    built = root / "target/release/doze-bworser-mcp"
    if not built.is_file():
        raise SystemExit("Run cargo build --release --locked first.")
    settings_dir = user_dir / ".config/doze-bworser-mcp"
    settings_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_path = settings_dir / "config.json"
    install_lock = (settings_dir / "install.lock").open("a")
    try:
        fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another installation is already in progress.") from None
    if settings_path.exists():
        settings = json.loads(settings_path.read_text())
    else:
        settings = {
            "port": 45917,
            "token": secrets.token_hex(32),
            "chrome_path": str(user_dir / ".local/share/codex-browser/chrome/current/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            "operation_timeout_seconds": 20,
        }
    if not Path(settings["chrome_path"]).is_file():
        raise SystemExit("Configure chrome_path with a dedicated Chrome for Testing executable.")
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise SystemExit("Install Node.js and npm before running the installer.")
    runtime = prepare_runtime(root, user_dir, npm)
    settings["node_path"] = node
    settings.pop("devtools_path", None)
    settings["worker_path"] = str(runtime / "worker.mjs")
    binary = user_dir / ".local/bin/doze-bworser-mcp"
    binary.parent.mkdir(parents=True, exist_ok=True)

    label = "com.masasam.doze-bworser-mcp"
    agents = user_dir / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    logs = user_dir / "Library/Logs/doze-bworser-mcp"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist = agents / (label + ".plist")
    plist_data = {
        "Label": label,
        "ProgramArguments": [str(binary), "serve", "--config", str(settings_path)],
        "RunAtLoad": True,
        "KeepAlive": True,
        # Background also throttles Chromium while it handles user requests.
        "ProcessType": "Interactive",
        "StandardOutPath": str(logs / "stdout.log"),
        "StandardErrorPath": str(logs / "stderr.log"),
    }
    replace_service(settings, settings_path, built, binary, plist, plist_data)

    codex = user_dir / ".codex"
    codex.mkdir(parents=True, exist_ok=True)
    config_path = codex / "config.toml"
    source = config_path.read_text() if config_path.exists() else ""
    section = (
        '[mcp_servers.doze-bworser-mcp]\n'
        f'url = "http://127.0.0.1:{settings["port"]}/mcp"\n'
        f'http_headers = {{ Authorization = "Bearer {settings["token"]}" }}\n'
        'tool_timeout_sec = 90\n'
    )
    pattern = r"(?ms)^\[mcp_servers\.doze-bworser-mcp\]\n.*?(?=^\[|\Z)"
    updated = re.sub(pattern, section + "\n", source) if re.search(pattern, source) else source.rstrip() + "\n\n" + section
    tomllib.loads(updated)
    if source != updated:
        if config_path.exists():
            shutil.copy2(config_path, settings_dir / "codex-config.before-install.toml")
            (settings_dir / "codex-config.before-install.toml").chmod(0o600)
        config_path.write_text(updated)
        config_path.chmod(0o600)

    hooks_path = codex / "hooks.json"
    hooks = json.loads(hooks_path.read_text()) if hooks_path.exists() else {"hooks": {}}
    original_hooks = json.dumps(hooks, ensure_ascii=False, indent=2) + "\n"
    for event in ["SessionStart", "SubagentStart", "SessionEnd"]:
        entries = hooks.setdefault("hooks", {}).setdefault(event, [])
        for entry in entries:
            entry["hooks"] = [hook for hook in entry.get("hooks", [])
                              if "doze-bworser-mcp" not in hook.get("command", "")
                              and not (event != "SessionEnd" and "codex-browser hook" in hook.get("command", ""))]
        entries[:] = [entry for entry in entries if entry.get("hooks")]
        entries.append({"hooks": [{"type": "command", "command": str(binary) + " hook", "timeout": 3,
                                    **({"additionalContextLimit": 400} if event == "SessionStart" else {})}]})
    serialized = json.dumps(hooks, ensure_ascii=False, indent=2) + "\n"
    if serialized != original_hooks:
        if hooks_path.exists():
            shutil.copy2(hooks_path, settings_dir / "codex-hooks.before-install.json")
            (settings_dir / "codex-hooks.before-install.json").chmod(0o600)
        hooks_path.write_text(serialized)
        hooks_path.chmod(0o600)
    print(f"Installed {binary}")
    print(f"Registered HTTP MCP at http://127.0.0.1:{settings['port']}/mcp")
    print("Existing Codex threads may need an MCP configuration reload; new hooks may need to be trusted in /hooks.")


if __name__ == "__main__":
    main()
