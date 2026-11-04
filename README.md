# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

A local MCP service that shares one lazily started Chrome for Testing across Codex threads. Discovery does not start a browser. Operations, including JavaScript evaluation, run concurrently across pages. Operations on one page run in order. Calls return completed results.

## Requirements

- macOS, Rust 1.88 or later to build, and Python 3.11 or later for installation.
- Node.js 22.12.0 or later, plus npm.
- A dedicated Google Chrome for Testing executable. The normal user browser is never selected automatically.
- A Codex client with Streamable HTTP MCP support.

Only the Rust broker runs while unused. The first browser operation starts one shared Node.js Puppeteer worker and Chromium; the final closed page stops both. Browser automation and accessibility data use puppeteer-core 25.16.0 public APIs. Page listing obtains browser-side URL/title metadata through Puppeteer’s public CDP sessions. Headless browsing shares one Chromium instance. Explicit joint viewing uses a separate headed instance.

Sandboxed clients connect over HTTP MCP. Chromium starts under the LaunchAgent, outside the command sandbox. Environments that prohibit loopback connections cannot use this service.

## Install

```sh
cargo build --release --locked
python3 scripts/install.py
```

The installer uses the existing dedicated Chrome for Testing at `~/.local/share/codex-browser/chrome/current/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. Set `chrome_path` in `~/.config/doze-bworser-mcp/config.json` for another dedicated installation.

The installer prepares pinned Puppeteer dependencies and the worker under `~/.local/share/doze-bworser-mcp/runtimes/<version>`. It prepares a separate directory before pausing the idle service and switching versions. Existing runtime files are not overwritten.

Installation registers the `com.masasam.doze-bworser-mcp` LaunchAgent, an authenticated loopback HTTP MCP in `~/.codex/config.toml`, and lifecycle hooks. The service starts at login and remains available without Chromium until a browser tool needs it. The default port is 45917. The access token is stored in private configuration files; do not publish those files.

Existing Codex threads may need their MCP configuration reloaded. Newly changed hook definitions may need to be trusted using `/hooks`. The installer preserves unrelated settings and saves the previous Codex configuration and hooks in the private settings directory. It replaces old codex-browser startup hooks but retains its end hook to clean up pre-existing sessions.

## Use

Before updating the installed service, close its managed pages. The installer atomically refuses updates while pages are active and blocks new pages until the update completes. Installations predating the `/update` endpoint require a one-time service stop before updating.

1. Call `open_page` with an HTTP(S) URL and optional `headed: true` for explicit joint viewing.
2. Pass the returned `page_id` to every page operation.
3. Use `inspect_page` to read the DevTools-style accessibility tree. Pass a displayed `uid` as `element` to `click` or `fill`.
4. Use `take_screenshot` to receive an image. Project-provided capture and audit CLIs remain the preferred way to produce their formal artifacts.
5. Call `close_page` when finished.

Tools: `open_page`, `list_pages`, `inspect_page`, `navigate_page`, `click`, `fill`, `press_key`, `scroll_page`, `set_viewport`, `take_screenshot`, `evaluate_script`, `handle_dialog`, `close_page`.

`headed: true` is only for explicit joint viewing. It opens an automation-owned window and does not attach to a user's existing browser. `set_viewport` changes page emulation, not the user window size.

Results use MCP `content` only: `open_page` returns `page_id`; `list_pages` returns an array of IDs, URLs and titles; `inspect_page` returns text; `take_screenshot` returns an image; `evaluate_script` returns its JSON result; other operations return `OK`. Pages start at 1440×900; use `set_viewport` to change the size.

Inspection reads Puppeteer’s accessibility snapshot, adds page-local element references, and uses the Apache-2.0 text formatter adapted from Chrome DevTools MCP 1.12.0. Only the latest inspection’s references are accepted; Puppeteer resolves their elements and rejects references from a navigated document. No DevTools MCP server or private Puppeteer API is used.

## Ownership and completion

Codex thread identity comes from request metadata, not model-provided arguments. Parent/child metadata and lifecycle hooks associate related threads with one isolated browser context. Each caller can list and operate only its own pages. A non-Codex MCP client is scoped to its MCP connection. Closing an MCP connection removes that connection's pages, leaving other connections in use. Ending a parent thread closes that parent's managed pages and those of its children. Closing the final page stops the corresponding dedicated browser.

Puppeteer handles navigation and element readiness. Input operations report action completion, not proof of a downstream business result. Inspect the resulting page to verify that result. Use uid values from the latest `inspect_page`; Puppeteer manages element handles. The accessibility tree includes input values and states exposed by Chromium.

Pages idle for at least 30 minutes are closed periodically. Operations in progress are excluded. A closed page returns an error asking you to open a new page.

Dialogs opened during `evaluate_script` are dismissed. A dialog during a newly opened page leaves the page available; its error includes `page_id`.

If a JavaScript dialog is open, operations return an error with its message. Call `handle_dialog` to accept or dismiss it, then inspect the result without repeating the original action.

The default waiting and operation deadlines are 20 seconds each. A request that expires while waiting for a page is not executed. If a running request times out or is cancelled, its page is closed to prevent subsequent work using an uncertain page state; external effects may already have happened. The operation is never automatically retried. If a page cannot be closed, its shared worker is stopped, losing all pages owned by that worker. Browser crashes lose the affected pages; stale IDs are not reassigned.

The service binds only to `127.0.0.1`, requires bearer authentication and validates Host and Origin. The service runs with its own OS permissions; MCP does not remove operating-system or Codex tool approval controls. Only the dedicated browser and its temporary profiles are managed.

## Verify

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
python3 -m unittest discover -s scripts -p 'test_*.py'
DOZE_BROWSER_CHROME='/absolute/path/to/Chrome for Testing executable' cargo test --locked --test service -- --ignored --test-threads=1
```

The real-browser tests use a local fixture and a dedicated headless browser. They cover shared startup, cookie/storage isolation, page ownership, concurrent navigation, ordering within a page, input, screenshot output, connection cleanup and timeout cleanup.

CI runs formatting, Clippy and the ordinary Rust, Node.js and installer test suites on pushes and pull requests. Real-browser tests are explicit opt-in checks. There is no automatic deployment or release workflow. Development uses the current branch unless a task specifies another branch.

## License

MIT. The adapted snapshot formatter is Apache-2.0; see [its attribution and license](runtime/vendor/README.md).
