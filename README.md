# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

This development branch uses Electron. Published 0.2.0 packages still use Chrome; the joint-viewing interface described below has not been released.

A local MCP endpoint that shares a dedicated Electron runtime across Codex threads. Different pages run concurrently; operations on one page run in order. Each call waits for completion, except an operation interrupted by a JavaScript dialog: respond with `handle_dialog` without repeating the operation.

## Architecture

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| Rust stdio launcher | Start or find the shared service, authenticate, forward bytes | One per MCP connection |
| Shared Rust supervisor | Hold the OS file lock and wait for Node | One per running service |
| Shared Node endpoint | Official MCP SDK, Puppeteer, ownership, queues, cancellation | Until the last connection closes, then a short cleanup delay |
| Dedicated Electron per project | Render and operate pages with saved login state | The project's first `open_page` through last page closure |

Codex launches Rust through standard MCP stdio. Rust and Node use Unix domain sockets on macOS/Linux and named pipes on Windows. Rust does not parse MCP or implement an internal browser RPC. Node is the only MCP endpoint. A small HMAC-SHA256 greeting authenticates both peers without transmitting the credential and selects the MCP stream or status query. Unix sockets live inside a private directory. There is no MCP TCP listener, HTTP MCP relay, or OS login service.

Each Git worktree root, or working folder outside Git, uses one dedicated Electron process and persistent profile. Callers share project storage but own separate pages. Pages normally remain hidden. Explicit joint viewing shows the same live page without restarting it or interrupting other pages. Puppeteer-core public APIs handle input and accessibility snapshots.

## Joint viewing

Use `headed: true` with `open_page`, or `show_page` for an existing page. Pages with the same owner and storage partition share one window. A single 48px row contains back/forward/reload and tabs. The selected tab expands to show its title and domain; click it again or press Command+L (Ctrl+L on Linux) to edit its URL in place. Other tabs show favicons, with overflow available under “⋯”.

Shortcuts are registered through Electron menu accelerators. macOS uses application, File, Edit, View, History and Window menus. The standard Edit menu includes undo/redo, cut, copy, paste, paste and match style, and select all. On Linux the menu bar is normally hidden and can be shown with Alt.

The controls follow the OS light/dark setting with a monochrome palette. Inactive tabs have both a background and a border.

Use the pencil button at the right to enter annotation mode. Hover to see an element outline and tag, then click it or drag to select an area, then enter a comment in the editor beside the selection. Save with the button or ⌘Enter (Ctrl+Enter on Linux). The toolbar changes its appearance and shows an annotation-mode label while active. Hover over the annotation control to open the saved-comment list. Saved annotations appear as numbered pins; hover over a pin to preview its comment, click a pin or comment to edit it, or use the × beside a comment to delete it. Selection gestures do not reach the underlying page. AI page operations pause during annotation mode, while `get_annotations` remains available. After adding comments, ask the assistant to read the annotations.

After selecting an element, use the sliders icon beside the comment input to preview text and typography, colors and corner radius, dimensions and spacing, or layout. Spacing and dimensions appear as a box-model diagram: edit margin and padding on their corresponding sides, or width and height in the center. Bare length numbers use pixels. Changes preview immediately and can be saved without a comment. Saved annotations expose before/after values in `adjustments` through `get_annotations`. Canceling or hiding the view discards unsaved adjustments. Saved previews remain in the same document; deleting an annotation removes its changes while preserving overlapping changes from other annotations. Re-editing and saving an adjustment gives it precedence. Reset removes the adjustment from the annotation being edited.

Adjust previews are temporary and do not edit source files or perform site save actions. Reloading removes the preview. Ask the assistant to implement saved annotation changes for a permanent result. Direct text editing is limited to leaf HTML elements outside form controls and editable regions. Area annotations do not offer Adjust.

Annotations record comments, URLs, rectangles, element tags and selectors, viewport size, and scroll position. They do not automatically collect images or input values. Selecting protected password or 1Password content is refused, as is selecting or saving while a password is entered. Hiding a page preserves its annotations; closing the page or stopping the browser discards them. Navigation keeps earlier annotations available with `current: false` and hides their pins.

In persistent profiles, the “1P” button installs the official 1Password Chrome extension. The first use opens 1Password's setup tab; the extension handles subsequent button clicks. Right-click the button for settings and updates. The extension and its account data use each project's storage and are separate from your regular Chrome profile. Extensions are unavailable in temporary sessions. To use the extension independently, turn off desktop app integration in its settings. Touch ID integration has not been verified.

Once 1Password is enabled for a profile, arbitrary JavaScript through `evaluate_script` is disabled. Normal inspection, clicks and input continue through existing element IDs. Installation is refused if arbitrary JavaScript has already run in that browser session; close all pages and reopen the browser before installing. The restriction persists across restarts, including after an installation failure.

Inspection omits password values and actionable IDs for password fields, and omits the entire contents of 1Password suggestion frames. Fields are identified by `type="password"` or `autocomplete="current-password"`/`new-password`; protection survives visibility toggles in the same document. Screenshots are refused while password fields or suggestion frames exist. Page inspection and operations are refused while a password field has a value. Operations resume when the fields are removed or emptied, even without a URL change. Results are also discarded if relevant changes occur during acquisition.

Extension documents and pages on 1Password domains are reserved for the user and excluded from AI listing, inspection, capture and operations. Tabs that become user-only, and their child tabs, stay user-only. Users can still access the extension from the toolbar. This protection applies to doze's MCP operations; it does not restrict a shell or separate screen capture tools running as the same OS user. Custom secret inputs without standard password attributes are outside the detection scope.

| Action | macOS | Linux |
| --- | --- | --- |
| Edit URL | Command+L | Ctrl+L |
| Shown tab 1–8 / last shown tab | Command+1–8 / Command+9 | Ctrl+1–8 / Ctrl+9 |
| Next / previous shown tab | Control+Tab / Control+Shift+Tab, Command+Shift+] / Command+Shift+[ | Ctrl+Tab / Ctrl+Shift+Tab |
| Back / forward | Command+[ / Command+], Command+Left / Command+Right | Ctrl+[ / Ctrl+], Alt+Left / Alt+Right |
| Reload / reload ignoring cache | Command+R / Command+Shift+R | Ctrl+R / Ctrl+Shift+R, F5 / Shift+F5 |
| Stop loading | Esc | Esc |
| Zoom in / out / reset | Command++ / Command+− / Command+0 | Ctrl++ / Ctrl+− / Ctrl+0 |
| Hide selected tab / window | Command+W / Command+Shift+W | Ctrl+W / Ctrl+Shift+W |

Tab numbering and cycling include shown tabs in “⋯”, but exclude pages hidden with ×. While a dialog is open, browser shortcuts other than tab selection and hiding are suppressed; Esc responds to the dialog. Esc cancels URL editing while the address field is focused.

Take turns with the user on the same page. Closing the window, including the macOS red button, hides the window and preserves its pages. A tab’s × only removes it from the joint view; hiding the final tab hides the window. `show_page` restores the same live page. AI and system operations own page termination: `close_page` closes the page and its child pages.

Popups inherit the opener's owner and appear in `list_pages`. Hidden pages create hidden popups; popups from the selected visible page appear as tabs in the same window, and the opener remains available as a tab. Respond to `alert`, `confirm` and `prompt` through MCP while hidden, or through the window's dialog while visible. `handle_dialog` accepts an optional `prompt_text`; omitting it uses the prompt's initial value.

Site permission requests are denied while hidden and require confirmation in the joint UI when visible.

Screenshots use Electron’s public capture API. Full-page captures temporarily expand the page rendering area, then restore its size and scroll position. The OS window is not resized.

Dedicated parent-child pipes carry browser control and CDP. No debugging TCP port is opened. Website content has no Node.js integration and is isolated from the browser UI.

The runtime is pinned to Electron 45.3.1 because dialog handling uses an internal Electron event. Verify initial navigation, popups, dialog types and shutdown when updating it. Authentication providers that restrict embedded browsers, including Google OAuth, may reject sign-in. See [Google's OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies).

## Saved login state

Working folders come automatically from `sandboxCwd` in Codex's experimental `codex/sandbox-state` request metadata. Git enrichment in `workspaces` is not used.

| Working folder | Storage identity |
| --- | --- |
| Inside Git | The worktree root, shared across subfolders and Codex projects using that root |
| Outside Git | The canonical working folder, persisted independently for each folder |

Symlinks to the same folder share storage. Separate checkouts and worktrees use separate storage. Git-managed folders require the Git executable. If the folder containing the nearest `.git` entry and the root returned by Git do not match, the page opens in an isolated temporary context without saved login state, and the result includes a warning. Temporary contexts are isolated by root thread and working folder and discarded when all their pages close. Saved profiles are left unchanged. Other discovery failures, including failed Git invocations, return an error. Folders outside Git do not invoke Git.

Profiles are stored under `~/.config/doze-bworser-mcp/profiles/electron/<workspace-hash>/`. Existing Chrome profiles are left untouched; the first use after migration requires signing in again. Cookies, localStorage and IndexedDB survive page closure, timeouts, MCP disconnects and service restarts. Session cookies, which Electron normally discards at restart, are saved separately using OS encryption and restored without changing expiration attributes. Signing out removes the saved cookies too. Unavailable secure encryption causes an error rather than plaintext storage. Previous pages and operations are never replayed. Site-side expiry, revocation or unsaved changes before a crash can still require signing in again.

Profiles contain authentication data: do not commit or publish them. On Unix, profile directories are accessible only to their owner. Sign out through the target site. To remove all saved project data, close every MCP connection, confirm the service has exited with `doze-bworser-mcp status`, then delete the `profiles` directory.

When Codex does not supply `sandboxCwd`, `open_page` returns an error. Update to a supported Codex version and reconnect this MCP server. Non-Codex clients without working-folder metadata retain temporary storage isolated per connection; this storage is not persisted.

## Installation

```sh
brew install mmng-a/tap/doze-bworser-mcp
codex mcp add doze-bworser-mcp -- doze-bworser-mcp
```

Homebrew builds the Rust launcher and installs Node.js and the runtime dependencies. The first `open_page` downloads the pinned Electron runtime through its official downloader. Your everyday browser is not used.

Alternatively, install with npm using Node.js 22.12 or newer. Rust is not required:

```sh
npm install -g doze-bworser-mcp@0.2.0
codex mcp add doze-bworser-mcp -- doze-bworser-mcp
```

npm selects the native package for your OS and CPU automatically. Electron downloads on first use. Choose either Homebrew or npm for the command installation.

If the MCP client cannot find the executable, register the absolute path reported by `command -v doze-bworser-mcp` (PowerShell: `(Get-Command doze-bworser-mcp).Source`). To configure MCP directly:

```toml
[mcp_servers.doze-bworser-mcp]
command = "doze-bworser-mcp"
tool_timeout_sec = 90
```

No installer or lifecycle hooks are required. The MCP server does not rewrite client configuration. On first startup, private transport credentials are prepared under `~/.config/doze-bworser-mcp`; dedicated browsers are stored under `~/.cache/doze-bworser-mcp`. Do not publish credential files. The first browser download can take some time.

Before upgrading, close every MCP connection to this server and confirm the shared service has exited with `doze-bworser-mcp status`. Then upgrade with the installation method you chose: `brew upgrade mmng-a/tap/doze-bworser-mcp` or `npm install -g doze-bworser-mcp@0.2.0`, and reconnect. Use `doze-bworser-mcp status` to inspect the shared service.

Homebrew is available on macOS and Linux; npm also supports Windows x64. To build from source, install Rust 1.89+, Node.js 22.12+ and npm:

```sh
npm ci --ignore-scripts --prefix runtime
DOZE_RUNTIME_DIR="$PWD/runtime" cargo build --release --locked
codex mcp add doze-bworser-mcp -- /absolute/path/to/target/release/doze-bworser-mcp
```

Source builds must explicitly select the runtime using `DOZE_RUNTIME_DIR` as above. Homebrew and npm archives set it automatically. In Windows PowerShell, set `$env:DOZE_RUNTIME_DIR = (Resolve-Path runtime).Path`, then run `cargo build --release --locked`.

For npm distribution targets and maintainer steps, see [npm/README.md](https://github.com/mmng-a/doze-bworser-mcp/blob/main/npm/README.md).

MCP does not remove OS restrictions or tool approval requirements. Hosts that sandbox MCP processes must permit local IPC and browser downloading and startup.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `open_page` | `url`, optional `headed` | `{ "page_id": "…" }` |
| `show_page` | `page_id` | `OK` after displaying the existing page for joint interaction |
| `list_pages` | None | Own pages with IDs, URLs, titles |
| `inspect_page` | `page_id` | DevTools-style accessibility text with `uid` references |
| `get_annotations` | `page_id` | User-saved annotation comments, locations, and URLs |
| `navigate_page` | `page_id`, `url` | `OK` after DOM readiness |
| `click` | `page_id`, `element` | `OK` |
| `fill` | `page_id`, `element`, `value` | `OK` |
| `press_key` | `page_id`, `key` | `OK` |
| `scroll_page` | `page_id`, `y`, optional `x` | `OK` |
| `set_viewport` | `page_id`, `width`, `height` | `OK` |
| `take_screenshot` | `page_id`, optional `full_page` | PNG image |
| `evaluate_script` | `page_id`, `expression` | JSON result, awaiting returned promises |
| `handle_dialog` | `page_id`, `accept`, optional `prompt_text` | `OK` after the interrupted operation settles, or the next dialog |
| `close_page` | `page_id` | `OK` after closure |

Results use MCP `content` only. For `open_page`, the first text block contains `{ "page_id": "…" }`; a separate text block contains a warning when temporary storage is used because of a Git root mismatch. Relay this warning to the user. URLs must be HTTP(S) or `about:blank`. Public schemas and argument validation come from the same Zod definitions through the official MCP SDK; strings such as `"false"` are not accepted as booleans.

Use `inspect_page` before element operations. Only references from the latest completed inspection are valid. Native HTML options use Puppeteer's selection API; disabled or ambiguous options return errors. Custom widgets use normal clicks. Windows open at 1200×900; viewport emulation does not resize the user's window. Headed mode is only for explicit joint viewing. Formal project capture/check CLIs take precedence for deliverables.

## Operation and cleanup

- Caller identity and workspace folders come from Codex metadata, not model-supplied arguments. Sharing storage does not grant access to another thread's pages. Disconnecting closes that connection's pages.
- Pages idle for 30 minutes close automatically, including pages waiting for a dialog. Active operations are bounded separately. Old page IDs are never reassigned; open a new page after closure.
- Queue waiting and active execution each default to 20 seconds. Browser startup and target listing are bounded too. Dialog input does not inherit an independent CDP deadline. Queued canceled or expired calls do not execute. Active cancellation or timeout closes the uncertain page; external effects may already have happened. Calls are never retried automatically. A page that blocks navigation through `beforeunload` stays open and the navigation returns an error; approving that departure through MCP is not supported.
- A dialog response does not release the page's operation slot. The original operation stays tracked, its execution deadline pauses during dialog input, and ordinary operations cannot overlap it. `handle_dialog` resumes and waits for it. A dialog during `open_page` reports the retained `page_id` in the error.
- `close_page` interrupts active work. Cancellation before closure begins leaves the page alone; once begun, closure continues to completion. If page allocation cannot be canceled safely or page cleanup hangs, the affected dedicated browser is terminated, losing its other pages too.
- Closing a project's last page stops its Electron process and retains its profile. Temporary profiles used by non-Codex clients are removed. Node remains while MCP clients are connected and exits after the last disconnect. If Node or Electron fails, affected pages are lost; reconnect and open a new page. Started browser actions are not replayed. Before MCP forwarding starts, startup disconnects and stopping notices reconnect within a 10-second budget. Authentication failures and started MCP requests are never retried.
- A successful input operation is not proof that an external business action succeeded. Check the resulting page when necessary.

Accessibility formatting uses code derived from Chrome DevTools MCP under Apache-2.0. Its license and attribution are retained in `runtime/vendor`.

## Git workflow

- `dev` holds ongoing development; `main` holds the code selected for distribution.
- Changes move from `dev` to `main`.

## Validation and CI

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
DOZE_BROWSER_ELECTRON='/absolute/path/to/dedicated/electron' DOZE_TEST_VIEWER=1 cargo test --locked --test service
```

Default tests do not start Electron. They cover ownership, concurrency, cancellation, dialog waits and workspace storage. Real-browser tests use local fixtures and `DOZE_BROWSER_ELECTRON` to check input, inspection, screenshots, popups, dialogs, persistent storage and cleanup. Add `DOZE_TEST_VIEWER=1` to exercise URL navigation, dialog input and hiding through the joint UI. These tests require a display. On macOS, joint UI tests default to inactive, non-focusable windows. Use `DOZE_TEST_BACKGROUND=0` only when explicitly checking foreground behavior. This applies only to the test launcher; normal joint viewing is unchanged. Physical-key accelerator delivery still requires a separate check. The new runtime has not been verified on Windows.

Linux requires a display session and a Secret Service provider, such as GNOME Keyring, for OS encryption. CI supplies a virtual display and temporary keyring. ZIP extraction pins `yauzl` to 3.4.0 for Node 24+ compatibility. Only official Electron artifacts are extracted, after checksum verification by the download library.

CI runs only when started manually with Run workflow or `gh workflow run ci.yml -f os=ubuntu-latest -f suite=browser`. Choose Linux, Windows or macOS for each run. Pushes and pull requests do not start CI. The separate manual `npm-packages.yml` workflow builds and checks npm archives for four OS/CPU combinations without publishing them. Choose `light` for the default suite or `browser` to also download pinned Electron and test real browsers and joint viewing. The selected runner performs formatting, Clippy, Rust and Node checks. It does not deploy or install the service.
