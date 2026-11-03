#!/usr/bin/env python3
"""Install the built local service and register its HTTP MCP and lifecycle hooks."""

import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import subprocess
import tomllib
import time
import urllib.error
import urllib.request


def main():
    root = Path(__file__).resolve().parents[1]
    user_dir = Path.home()
    built = root / "target/release/doze-bworser-mcp"
    if not built.is_file():
        raise SystemExit("Run cargo build --release --locked first.")
    settings_dir = user_dir / ".config/doze-bworser-mcp"
    settings_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_path = settings_dir / "config.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text())
        request = urllib.request.Request(
            f'http://127.0.0.1:{settings["port"]}/health',
            headers={"Authorization": "Bearer " + settings["token"]},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                state = json.load(response)
            if state.get("name") != "doze-bworser-mcp" or state.get("page_count", 0):
                raise SystemExit("The service has active pages. Close them before updating.")
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ConnectionRefusedError):
                raise SystemExit("Cannot safely verify the existing service before updating.") from error
    else:
        settings = {
            "port": 45917,
            "token": secrets.token_hex(32),
            "chrome_path": str(user_dir / ".local/share/codex-browser/chrome/current/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
            "operation_timeout_seconds": 20,
        }
    if not Path(settings["chrome_path"]).is_file():
        raise SystemExit("Configure chrome_path with a dedicated Chrome for Testing executable.")
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    settings_path.chmod(0o600)
    binary = user_dir / ".local/bin/doze-bworser-mcp"
    binary.parent.mkdir(parents=True, exist_ok=True)
    pending = binary.with_suffix(".new")
    shutil.copy2(built, pending)
    pending.chmod(0o755)
    pending.replace(binary)

    label = "com.masasam.doze-bworser-mcp"
    agents = user_dir / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    logs = user_dir / "Library/Logs/doze-bworser-mcp"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist = agents / (label + ".plist")
    with plist.open("wb") as stream:
        plistlib.dump({
            "Label": label,
            "ProgramArguments": [str(binary), "serve", "--config", str(settings_path)],
            "RunAtLoad": True,
            "KeepAlive": True,
            # Background also throttles Chromium while it handles user requests.
            "ProcessType": "Interactive",
            "StandardOutPath": str(logs / "stdout.log"),
            "StandardErrorPath": str(logs / "stderr.log"),
        }, stream)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], check=False, capture_output=True)
    deadline = time.monotonic() + 10
    while subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True).returncode == 0:
        if time.monotonic() >= deadline:
            raise SystemExit("The previous service is still stopping; installation did not start another instance.")
        time.sleep(0.1)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)

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
