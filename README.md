# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

A local MCP endpoint that shares a dedicated Chrome for Testing across Codex threads. Different pages run concurrently; operations on one page run in order. Each call waits for completion, except an operation interrupted by a JavaScript dialog: respond with `handle_dialog` without repeating the operation.

## Architecture

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| Rust stdio launcher | Start or find the shared service, authenticate, forward bytes | One per MCP connection |
| Shared Rust supervisor | Hold the OS file lock and wait for Node | One per running service |
| Shared Node endpoint | Official MCP SDK, Puppeteer, ownership, queues, cancellation | Until the last connection closes, then a short cleanup delay |
| Dedicated Chromium | Render and operate pages | First `open_page` through last page closure |

Codex launches Rust through standard MCP stdio. Rust and Node use Unix domain sockets on macOS/Linux and named pipes on Windows. Rust does not parse MCP or implement an internal browser RPC. Node is the only MCP endpoint. A small HMAC-SHA256 greeting authenticates both peers without transmitting the credential and selects the MCP stream or lifecycle/status controls. Unix sockets live inside a private directory. There is no TCP listener, HTTP MCP relay, or OS login service.

Normal headless pages share one browser globally per OS user. Explicit joint viewing uses one separate headed browser. Storage is isolated by root thread; each caller owns its own pages. Puppeteer-core 25.16.0 public APIs handle browser operations and accessibility snapshots. DevTools MCP's Apache-2.0 text formatter is reused; the DevTools MCP server is not run.

## Requirements and installation

- macOS, Linux, or Windows; Rust 1.89+ to build and Python 3.11+ to install.
- Node.js 22.12.0+ and npm.
- A dedicated Chrome for Testing executable. The user's ordinary browser is never selected automatically.
- A Codex client supporting stdio MCP and lifecycle hooks.

```sh
cargo build --release --locked
python3 scripts/install.py --chrome '/absolute/path/to/dedicated/chrome'
```

Use `python` on Windows if that is your Python command. Subsequent installs reuse the configured Chrome path and may omit `--chrome`.

The installer copies the launcher to `~/.local/bin`, prepares a pinned, immutable Node runtime under `~/.local/share/doze-bworser-mcp/runtimes`, and registers the stdio command and lifecycle hooks in Codex. Settings and authentication credentials are private under `~/.config/doze-bworser-mcp`; do not publish them. Unrelated Codex settings are preserved, with backups before changes. Reload existing threads' MCP configuration; changed hooks may require trust through `/hooks`.

Before updating, close MCP connections using the service. The installer refuses to replace a running service and holds the same native lock as its supervisor during replacement. It does not overwrite existing runtime directories. The old HTTP/LaunchAgent version must be stopped and its service registration removed before migration; remove its `port` setting after stopping it. This installer does not manage OS services.

```sh
doze-bworser-mcp status
doze-bworser-mcp stop
```

`status` reports connection, page, and browser counts. `stop` refuses while MCP connections or pages remain. Both report an error when the service is absent. The next MCP connection starts the service automatically.

The MCP launcher normally runs in the host client's tool environment, so browser operations do not require shell access to Chromium from a coding sandbox. MCP does not remove OS restrictions or tool approval requirements. A host that sandboxes the MCP process itself must permit its executable, local IPC, and browser startup.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `open_page` | `url`, optional `headed` | `{ "page_id": "…" }` |
| `list_pages` | None | Own pages with IDs, URLs, titles |
| `inspect_page` | `page_id` | DevTools-style accessibility text with `uid` references |
| `navigate_page` | `page_id`, `url` | `OK` after DOM readiness |
| `click` | `page_id`, `element` | `OK` |
| `fill` | `page_id`, `element`, `value` | `OK` |
| `press_key` | `page_id`, `key` | `OK` |
| `scroll_page` | `page_id`, `y`, optional `x` | `OK` |
| `set_viewport` | `page_id`, `width`, `height` | `OK` |
| `take_screenshot` | `page_id`, optional `full_page` | PNG image |
| `evaluate_script` | `page_id`, `expression` | JSON result, awaiting returned promises |
| `handle_dialog` | `page_id`, `accept` | `OK` after the interrupted operation settles, or the next dialog |
| `close_page` | `page_id` | `OK` after closure |

Results use MCP `content` only. URLs must be HTTP(S) or `about:blank`. Public schemas and argument validation come from the same Zod definitions through the official MCP SDK; strings such as `"false"` are not accepted as booleans.

Use `inspect_page` before element operations. Only references from the latest completed inspection are valid. Native HTML options use Puppeteer's selection API; disabled or ambiguous options return errors. Custom widgets use normal clicks. The initial viewport is 1440×900; viewport emulation does not resize the user's window. Headed mode is only for explicit joint viewing. Formal project capture/check CLIs take precedence for deliverables.

## Operation and cleanup

- Caller identity comes from Codex metadata, not model-supplied arguments. Hooks and parent metadata identify root threads. Non-Codex clients are isolated per connection. Disconnecting closes that connection's pages; ending a root thread closes its descendants' pages.
- Pages idle for 30 minutes close automatically, including pages waiting for a dialog. Active operations are bounded separately. Old page IDs are never reassigned; open a new page after closure.
- Queue waiting and active execution each default to 20 seconds. Browser startup and target listing are bounded too. Dialog input does not inherit an independent CDP deadline. Queued canceled or expired calls do not execute. Active cancellation or timeout closes the uncertain page; external effects may already have happened. Calls are never retried automatically.
- A dialog response does not release the page's operation slot. The original operation stays tracked, its execution deadline pauses during dialog input, and ordinary operations cannot overlap it. `handle_dialog` resumes and waits for it. A dialog during `open_page` reports the retained `page_id` in the error.
- `close_page` interrupts active work. Cancellation before closure begins leaves the page alone; once begun, closure continues to completion. If page allocation cannot be canceled safely or page cleanup hangs, the affected dedicated browser is terminated, losing its other pages too.
- Closing the last page stops the corresponding Chromium and removes its temporary profile. Node remains while MCP clients are connected and exits after the last disconnect. If Node or Chromium fails, affected pages are lost; reconnect and open a new page. Started browser actions are not replayed. Before MCP forwarding starts, startup disconnects and stopping notices reconnect within a 10-second budget. Authentication failures and started MCP requests are never retried.
- A successful input operation is not proof that an external business action succeeded. Check the resulting page when necessary.

## Validation and CI

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
python3 -m unittest discover -s scripts -p 'test_*.py'
DOZE_BROWSER_CHROME='/absolute/path/to/dedicated/chrome' cargo test --locked --test service
```

Default tests check concurrent cold startup, SDK schemas, ownership metadata, native locks, installer preservation, queue cancellation, dialog ordering, and cleanup without starting Chrome. The optional real-browser test uses a local fixture and dedicated headless Chrome for input, snapshots, screenshots, isolation, dialogs, concurrency and cancellation.

CI runs only when started manually with Run workflow or `gh workflow run ci.yml -f os=ubuntu-latest`. Choose Linux, Windows or macOS for each run. Pushes and pull requests do not start CI. The selected runner performs formatting, Clippy, Rust, Node and installer checks. It does not deploy or install the service. Work uses the current branch unless a task specifies another policy.
