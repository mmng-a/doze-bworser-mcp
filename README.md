# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

A local MCP endpoint that shares a dedicated Chrome for Testing across Codex threads. Different pages run concurrently; operations on one page run in order. Each call waits for completion, except an operation interrupted by a JavaScript dialog: respond with `handle_dialog` without repeating the operation.

## Architecture

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| Rust stdio launcher | Start or find the shared service, authenticate, forward bytes | One per MCP connection |
| Shared Rust supervisor | Hold the OS file lock and wait for Node | One per running service |
| Shared Node endpoint | Official MCP SDK, Puppeteer, ownership, queues, cancellation | Until the last connection closes, then a short cleanup delay |
| Dedicated Chromium per project | Render and operate pages with saved login state | The project's first `open_page` through last page closure |

Codex launches Rust through standard MCP stdio. Rust and Node use Unix domain sockets on macOS/Linux and named pipes on Windows. Rust does not parse MCP or implement an internal browser RPC. Node is the only MCP endpoint. A small HMAC-SHA256 greeting authenticates both peers without transmitting the credential and selects the MCP stream or status query. Unix sockets live inside a private directory. There is no MCP TCP listener, HTTP MCP relay, or OS login service.

Each Git worktree root, or working folder outside Git, uses a dedicated browser and persistent profile. Threads using the same storage share cookies and other data; each caller owns its own pages. Site browsers always run headless. Explicit joint viewing opens a live DevTools view in a separate dedicated Chrome. It displays the same page, so cookies need no synchronization and the profile is never opened by two browsers. Other headless pages continue concurrently without restarting the shared browser. Puppeteer-core 25.16.0 public APIs handle browser operations and accessibility snapshots. DevTools MCP's Apache-2.0 text formatter is reused; the DevTools MCP server is not run.

## Joint viewing

Use `headed: true` with `open_page`, or `show_page` for an existing page. DevTools provides an address bar, back/forward/reload and mouse/keyboard interaction with the page. Take turns with the user on the same page. Closing the view keeps the page running; `show_page` can reopen it. Closing the page or disconnecting its MCP connection also closes its view. The last view closes display Chrome. A display Chrome crash leaves headless pages running. If display-tab allocation or cleanup stalls, display Chrome is terminated and other joint views may also close.

Each open view has a WebSocket listener on a random `127.0.0.1` port. A random 256-bit capability path and the DevTools Origin are checked. Commands reach only the page and its attached child CDP sessions; browser shutdown and access to other tabs are blocked. Closing the page or view revokes the connection. Chrome itself exposes no TCP debugging port. Display Chrome uses a temporary profile without target-site cookies; normal shutdown removes it. A crash may leave it in the OS temporary directory.

DevTools has limitations with Japanese input: synthetic Japanese insertion did not reach the target page, and physical keyboard IME operation has not been verified. Automatic switching to popup views is also unsupported.

## Saved login state

Working folders come automatically from `sandboxCwd` in Codex's experimental `codex/sandbox-state` request metadata. Git enrichment in `workspaces` is not used.

| Working folder | Storage identity |
| --- | --- |
| Inside Git | The worktree root, shared across subfolders and Codex projects using that root |
| Outside Git | The canonical working folder, persisted independently for each folder |

Symlinks to the same folder share storage. Separate checkouts and worktrees use separate storage. Git-managed folders require the Git executable. If the folder containing the nearest `.git` entry and the root returned by Git do not match, the page opens in an isolated temporary context without saved login state, and the result includes a warning. Temporary contexts are isolated by root thread and working folder and discarded when all their pages close. Saved profiles are left unchanged. Other discovery failures, including failed Git invocations, return an error. Folders outside Git do not invoke Git.

Profiles are stored under `~/.config/doze-bworser-mcp/profiles/<hash-of-git-root-or-working-folder>/`. Cookies, localStorage, IndexedDB and other profile data survive tab closure, operation timeouts, MCP disconnections and service restarts. Startup enables native session restoration through dedicated Chrome's settings API, retaining session cookies too. Previous tabs are not reopened and operations are not replayed. Site-side expiration or revocation still requires signing in again. Unsaved changes immediately before an unexpected process exit may be lost.

Profiles contain authentication data: do not commit or publish them. On Unix, profile directories are accessible only to their owner. Sign out through the target site. To remove all saved project data, close every MCP connection, confirm the service has exited with `doze-bworser-mcp status`, then delete the `profiles` directory.

When Codex does not supply `sandboxCwd`, `open_page` returns an error. Update to a supported Codex version and reconnect this MCP server. Non-Codex clients without working-folder metadata retain temporary storage isolated per connection; this storage is not persisted.

## Installation

```sh
brew install mmng-a/tap/doze-bworser-mcp
codex mcp add doze-bworser-mcp -- doze-bworser-mcp
```

Homebrew builds the Rust launcher and installs Node.js and the runtime dependencies. The first `open_page` downloads the supported dedicated Chrome for Testing through Puppeteer's official browser manager. Your everyday browser is not used.

If the MCP client cannot find Homebrew's executable, register the absolute path reported by `command -v doze-bworser-mcp`. To configure MCP directly:

```toml
[mcp_servers.doze-bworser-mcp]
command = "doze-bworser-mcp"
tool_timeout_sec = 90
```

No installer or lifecycle hooks are required. The MCP server does not rewrite client configuration. On first startup, private transport credentials are prepared under `~/.config/doze-bworser-mcp`; dedicated browsers are stored under `~/.cache/doze-bworser-mcp`. Do not publish credential files. The first browser download can take some time.

Before upgrading, close every MCP connection to this server and confirm the shared service has exited with `doze-bworser-mcp status`. Then run `brew upgrade mmng-a/tap/doze-bworser-mcp` and reconnect. Use `doze-bworser-mcp status` to inspect the shared service.

Homebrew is available on macOS and Linux. Windows and source builds require Rust 1.89+, Node.js 22.12+ and npm:

```sh
npm ci --ignore-scripts --prefix runtime
DOZE_RUNTIME_DIR="$PWD/runtime" cargo build --release --locked
codex mcp add doze-bworser-mcp -- /absolute/path/to/target/release/doze-bworser-mcp
```

Source builds must explicitly select the runtime using `DOZE_RUNTIME_DIR` as above. Homebrew and npm archives set it automatically. In Windows PowerShell, set `$env:DOZE_RUNTIME_DIR = (Resolve-Path runtime).Path`, then run `cargo build --release --locked`.

npm distribution is prepared but not published to the npm registry. See [npm/README.md](https://github.com/mmng-a/doze-bworser-mcp/blob/main/npm/README.md) for targets and validation steps.

MCP does not remove OS restrictions or tool approval requirements. Hosts that sandbox MCP processes must permit local IPC and browser downloading and startup.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `open_page` | `url`, optional `headed` | `{ "page_id": "…" }` |
| `show_page` | `page_id` | `OK` after displaying the existing page for joint interaction |
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

Results use MCP `content` only. For `open_page`, the first text block contains `{ "page_id": "…" }`; a separate text block contains a warning when temporary storage is used because of a Git root mismatch. Relay this warning to the user. URLs must be HTTP(S) or `about:blank`. Public schemas and argument validation come from the same Zod definitions through the official MCP SDK; strings such as `"false"` are not accepted as booleans.

Use `inspect_page` before element operations. Only references from the latest completed inspection are valid. Native HTML options use Puppeteer's selection API; disabled or ambiguous options return errors. Custom widgets use normal clicks. The initial viewport is 1440×900; viewport emulation does not resize the user's window. Headed mode is only for explicit joint viewing. Formal project capture/check CLIs take precedence for deliverables.

## Operation and cleanup

- Caller identity and workspace folders come from Codex metadata, not model-supplied arguments. Sharing storage does not grant access to another thread's pages. Disconnecting closes that connection's pages.
- Pages idle for 30 minutes close automatically, including pages waiting for a dialog. Active operations are bounded separately. Old page IDs are never reassigned; open a new page after closure.
- Queue waiting and active execution each default to 20 seconds. Browser startup and target listing are bounded too. Dialog input does not inherit an independent CDP deadline. Queued canceled or expired calls do not execute. Active cancellation or timeout closes the uncertain page; external effects may already have happened. Calls are never retried automatically.
- A dialog response does not release the page's operation slot. The original operation stays tracked, its execution deadline pauses during dialog input, and ordinary operations cannot overlap it. `handle_dialog` resumes and waits for it. A dialog during `open_page` reports the retained `page_id` in the error.
- `close_page` interrupts active work. Cancellation before closure begins leaves the page alone; once begun, closure continues to completion. If page allocation cannot be canceled safely or page cleanup hangs, the affected dedicated browser is terminated, losing its other pages too.
- Closing a project's last page stops its Chromium and retains its profile. Temporary profiles used by non-Codex clients are removed. Node remains while MCP clients are connected and exits after the last disconnect. If Node or Chromium fails, affected pages are lost; reconnect and open a new page. Started browser actions are not replayed. Before MCP forwarding starts, startup disconnects and stopping notices reconnect within a 10-second budget. Authentication failures and started MCP requests are never retried.
- A successful input operation is not proof that an external business action succeeded. Check the resulting page when necessary.

## Validation and CI

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
DOZE_BROWSER_CHROME='/absolute/path/to/dedicated/chrome' DOZE_TEST_VIEWER=1 cargo test --locked --test service
```

Default tests check concurrent cold startup, SDK schemas, ownership and workspace metadata, shared headless pages and views, native locks, queue cancellation, dialog ordering, and cleanup without starting Chrome. Optional real-browser tests use local fixtures and dedicated headless Chrome for input, snapshots, screenshots, isolation, dialogs, concurrency and cancellation, plus cookies, localStorage and IndexedDB shared across project threads, retained after tab closure, timeout and service restart, and cleared on logout. Add `DOZE_TEST_VIEWER=1` to verify the address bar, clicks, ASCII input, parallel pages, view closure/crash and cancellation. These tests require a graphical environment.

CI runs only when started manually with Run workflow or `gh workflow run ci.yml -f os=windows-latest -f suite=browser`. Choose Linux, Windows or macOS for each run. Pushes and pull requests do not start CI. The separate manual `npm-packages.yml` workflow builds and checks npm archives for four OS/CPU combinations without publishing them. Choose `light` for the default suite or `browser` to also download pinned Chrome and test real browsers and joint viewing. The selected runner performs formatting, Clippy, Rust and Node checks. It does not deploy or install the service. Work uses the current branch unless a task specifies another policy.
