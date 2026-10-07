# Monday Task Bridge

A local Chrome extension and MCP server that let an AI agent read monday.com tasks and supported original image attachments through **your signed-in browser session**. It needs no monday API token, administrator-installed app, or monday MCP entitlement.

> **Project status:** Personal prototype. Typecheck, build, and automated extractor, pairing, bridge, and MCP tests pass in CI. Extraction and original-image retrieval have **not yet been verified against a real monday task** in the intended Chrome profile. Treat `complete` as a best-effort signal, and review `warnings` before relying on a snapshot.

## What it does

1. The extension detects a monday task you open and, when auto-sync is enabled, starts a capture in an **inactive temporary tab**. The tab is closed after capture.
2. It reads task fields, updates, replies, and Files links from the rendered page. It scrolls through lists that load incrementally. For links identified as original downloads, it retrieves the file using the browser session and checks the actual image bytes.
3. It sends the snapshot to a bridge bound to `127.0.0.1:3457`. A separate MCP process exposes the cached data and can request a fresh capture.

The extension does not call monday's official or private API, read or export cookie values, edit tasks, crawl boards, or substitute screenshots for original images. The signed-in page and authenticated downloads **do use the browser's existing session**. It can only access content your account can see in the web UI.

## Requirements

- Node.js **22.12+** and npm
- Google Chrome with access to your monday.com account and permission to load an unpacked extension
- A local MCP client, such as Codex, if you want an agent to use the captured data

The extension uses port `3457`. Keep that port free; the extension currently does not follow a custom `MONDAY_BRIDGE_PORT` value.

Commands below use PowerShell on Windows. The `npm` commands also work in a macOS/Linux shell; use that shell's absolute-path syntax when configuring an MCP client.

## Set up

From the repository root:

```powershell
npm ci
npm run build
npm run bridge
```

Leave the bridge terminal running. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this repository's `dist/extension` directory. Open the extension popup and click **Start Pairing**. In a second terminal, run the following command with the six-digit code shown in the popup:

```powershell
npm run pair -- 123456
```

The code expires after two minutes. Once the popup says **CONNECTED**, open a task with a URL containing `/boards/<board-id>/pulses/<item-id>` (an optional `/views/<view-id>` segment is supported). Auto-sync is on by default and can be paused in the popup. If the popup asks for an image host permission, grant it only if you recognize the host, then reopen the task to retry. After a new build, click **Reload** on the extension card in `chrome://extensions`.

Check the bridge without exposing a token:

```powershell
Invoke-RestMethod http://127.0.0.1:3457/health
```

In a macOS/Linux shell, use `curl http://127.0.0.1:3457/health`.

`paired: true` means the server has issued an extension token; `extensionConnected: true` means an authenticated extension is currently connected. Both must be true for a live MCP capture.

## Connect an MCP client

The bridge (`npm run bridge`) and the MCP server are **separate processes**. Keep the bridge running; the MCP client starts the stdio server. From the repository root, add it to Codex with:

```powershell
$bridgeMcp = (Resolve-Path .\dist\bridge\mcp.js).Path
codex mcp add monday-task-bridge -- node $bridgeMcp
```

For another stdio MCP client, set `command` to `node` and `args` to the absolute path of `dist/bridge/mcp.js`. The MCP process reads the local admin token from the same data directory as the bridge; no token belongs in client configuration. `npm run mcp` is available for development from this checkout.

| MCP tool | Result |
| --- | --- |
| `monday_bridge_status` | Bridge health, pairing, and extension connection state. |
| `monday_read_open_task` | Fresh snapshot from the active monday task tab, or the first open task tab if another tab is active. Waits up to 180 seconds. |
| `monday_get_task` | Latest cached snapshot, optionally filtered by `boardId` and/or `itemId`. |
| `monday_get_image` | Original PNG, JPEG, GIF, or WebP bytes for a ready attachment ID. |
| `monday_list_tasks` | Summaries of locally cached snapshots. |

Typical agent flow: call `monday_bridge_status`, then `monday_read_open_task`, inspect `complete` and `warnings`, and call `monday_get_image` only for an attachment whose status is `ready`. A missing original returns an explicit error.

## Local data and trust boundary

The receiver listens on loopback only. Browser web origins are rejected. A six-digit pairing code needs local CLI approval; afterwards extension requests require a bearer token and the paired extension origin. The MCP server uses a separate local admin token.

Snapshots, image bytes, and tokens are stored **unencrypted** under the current OS user's profile:

| OS | Default data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\monday-task-bridge` |
| macOS | `~/Library/Application Support/monday-task-bridge` |
| Linux | `$XDG_DATA_HOME/monday-task-bridge`, or `~/.local/share/monday-task-bridge` |

`MONDAY_BRIDGE_DATA_DIR` can override the directory for the bridge, pairing CLI, and MCP process; all three must use the same value. On each new snapshot, the store prunes toward **200 snapshots / 7 days** and deletes image files no longer referenced by retained snapshots. Old files are not pruned while no new captures occur. Protect access to your OS account and never commit the data directory or token files.

## Limits and troubleshooting

- **`BROWSER_OFFLINE` or `extensionConnected: false`:** Start the bridge, check the popup, and use **Reconnect** if needed. A paired extension can be disconnected while Chrome is closed.
- **`CAPTURE_TIMEOUT`:** A live capture did not finish within 180 seconds. Check the popup error and retry one task at a time.
- **`NO_SNAPSHOT`:** No cached task matches the requested IDs, or the MCP process could not obtain a capture. Check `monday_bridge_status` first.
- **No task tab found:** Open a task in the same Chrome profile as the extension, then call `monday_read_open_task` again. Board pages without an open task are not captured.
- **Capture incomplete:** Read `warnings`. monday can change its DOM, virtualize updates, hide Files links, or deny an original download. A `complete: false` snapshot is still usable for the data it contains; it does not claim to include everything. Even `complete: true` reflects only what the page exposed to the extractor.
- **`IMAGE_ORIGINAL_UNAVAILABLE` or image unavailable:** Only PNG, JPEG, GIF, and WebP originals are accepted after byte-level validation. SVG, other files, thumbnails, failed downloads, and images over **25 MB each** or **75 MB per capture** are not returned as original images. Grant a requested image-host permission in the popup and reopen the task when appropriate.
- **Pairing fails or expires:** Click **Start Pairing** again and approve the new code within two minutes. A replacement extension ID can pair again through the local CLI.
- **Concurrent captures:** The bridge does not queue multiple capture requests. Run one live capture at a time.

The extractor depends on monday's rendered UI, so a monday layout change can require selector updates. When reporting a failure, include the task URL shape, popup error, snapshot warnings, and a description of the missing field or attachment. Do not include session cookies, bridge tokens, or private task content in a public issue.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

The Chrome extension lives in `extension/`, the local HTTP/WebSocket receiver and MCP server in `bridge/`, and shared payload types in `shared/`. CI runs install, typecheck, tests, and build on Node.js 24. Generated files in `dist/` are intentionally not committed.
