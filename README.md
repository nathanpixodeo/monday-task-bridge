# Monday Task Bridge

Author: **Nhat Nguyen** · Developed by **Nexkit** · [nathanpixodeo@gmail.com](mailto:nathanpixodeo@gmail.com)

A local Chrome extension and MCP server that let an AI agent read monday.com tasks and their original image attachments through **your signed-in browser session**. It needs no monday API token, administrator-installed app, or monday MCP entitlement: sign in to monday in Chrome once, and the extension does the rest.

> **Project status:** Personal prototype. Typecheck, build, and automated pairing, bridge, API-mapping, and MCP tests pass in CI. Reading tasks through monday's web API has been checked against real tasks; treat `complete` as a best-effort signal and review `warnings` before relying on a snapshot.

## What it does

1. An agent asks for a task by link (or for the task open in your active tab).
2. The extension calls **monday's own web API** (`https://<account>.monday.com/v2`, GraphQL), the same endpoint monday's web app uses, with your browser session and the app's CSRF token. One request returns the task name, every column as readable text, updates with replies and authors, and the attached files. No tab opens and no page is rendered.
3. Original images are downloaded from monday's file storage and checked byte by byte. Files that are not images are listed in an `Other files` field.
4. The snapshot goes to a bridge bound to `127.0.0.1:3457`. A separate MCP process exposes cached snapshots and requests fresh reads.

The extension only reads: it never edits tasks, crawls boards, reads or exports cookie values, or substitutes screenshots for original images. It can only access tasks your monday account can see.

## Requirements

- Node.js **22.12+** and npm
- Google Chrome signed in to your monday.com account, with permission to load an unpacked extension
- A local MCP client, such as Codex, if you want an agent to use the data

The extension uses port `3457`. Keep that port free; the extension currently does not follow a custom `MONDAY_BRIDGE_PORT` value.

Commands below use PowerShell on Windows. The `npm` commands also work in a macOS/Linux shell; use that shell's absolute-path syntax when configuring an MCP client.

## Set up

From the repository root:

```powershell
npm ci
npm run build
npm run bridge
```

Leave the bridge terminal running while you pair; afterwards you can close it, because the MCP server starts the bridge on its own. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this repository's `dist/extension` directory. Open the extension popup. It checks that the bridge is running; tap the power button to pair. The popup shows a six-digit code and the exact command, each with a copy button. In a second terminal, run that command with your code, for example:

```powershell
npm run pair -- 123456
```

The code expires after two minutes; the popup shows a countdown. Once the popup says **Connected**, you are done: agents can read any task your account can see, by link. The power button turns the connection on and off; while off, reads report `BROWSER_OFFLINE`. After a new build, click **Reload** on the extension card in `chrome://extensions`.

The toolbar icon is in color while connected and grey otherwise. A badge flags anything that needs attention:

| Badge | Meaning |
| --- | --- |
| `…` (violet) | Reading a task, or waiting for pairing approval. |
| `!` (red) | Connection is on, but the bridge is offline or not connected. |
| `!` (amber) | The last read is incomplete. Open the popup to read its warnings. |
| `+` (amber) | An image host needs permission. |
| none | Connected (color icon), or turned off or not paired (grey icon). |

Check the bridge without exposing a token:

```powershell
Invoke-RestMethod http://127.0.0.1:3457/health
```

In a macOS/Linux shell, use `curl http://127.0.0.1:3457/health`.

`paired: true` means the server has issued an extension token; `extensionConnected: true` means an authenticated extension is currently connected. Both must be true for a live read.

## Connect an MCP client

The bridge and the MCP server are **separate processes**. The MCP client starts the stdio server, and the MCP server starts the bridge in the background whenever it is not running (its log goes to `bridge.log` in the data directory), so you do not need to keep `npm run bridge` open once paired. From the repository root, register it with your agent CLI:

```powershell
$bridgeMcp = (Resolve-Path .\dist\bridge\mcp.js).Path

# Claude Code (user scope: available in every project)
claude mcp add -s user monday-task-bridge -- node $bridgeMcp

# Codex
codex mcp add monday-task-bridge -- node $bridgeMcp

# Antigravity CLI (agy)
agy mcp add monday-task-bridge node $bridgeMcp
```

Check with `claude mcp list`, `codex mcp list`, or `agy mcp list`. For another stdio MCP client, set `command` to `node` and `args` to the absolute path of `dist/bridge/mcp.js`. The MCP process reads the local admin token from the same data directory as the bridge; no token belongs in client configuration. `npm run mcp` is available for development from this checkout.

| MCP tool | Result |
| --- | --- |
| `monday_bridge_status` | Bridge health, pairing, and extension connection state. |
| `monday_read_task` | Fresh snapshot of any task by `url`, or by `boardId` + `itemId` (optional `accountHost`, defaulting to the host of the latest cached task). You do not need to open the task. |
| `monday_read_open_task` | Fresh snapshot of the task open in the active tab, or the first open task tab if another tab is active. |
| `monday_get_task` | Latest cached snapshot, optionally filtered by `boardId` and/or `itemId`. |
| `monday_get_image` | Original PNG, JPEG, GIF, or WebP bytes for a ready attachment ID. |
| `monday_list_tasks` | Summaries of locally cached snapshots. |

Typical agent flow: call `monday_bridge_status`, then `monday_read_task` with the task link, inspect `complete` and `warnings`, and call `monday_get_image` only for an attachment whose status is `ready`. A missing original returns an explicit error.

## Local data and trust boundary

The receiver listens on loopback only. Browser web origins are rejected. A six-digit pairing code needs local CLI approval; afterwards extension requests require a bearer token and the paired extension origin. The MCP server uses a separate local admin token. **Unpair** in the popup revokes the extension token on the bridge and forgets the paired extension. Each new pairing issues a fresh token, so a token from an earlier pairing stops working, including one left behind by an unpair while the bridge was offline.

To call monday's web API, the extension reads the CSRF token monday embeds in its app page and sends it with your session cookie, exactly as monday's web app does. The token is kept in the extension's memory only; it is never sent to the bridge. The extension has host access to `*.monday.com` and to monday's file storage (`files-monday-com.s3.amazonaws.com`) for original images.

Snapshots, image bytes, and tokens are stored **unencrypted** under the current OS user's profile:

| OS | Default data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\monday-task-bridge` |
| macOS | `~/Library/Application Support/monday-task-bridge` |
| Linux | `$XDG_DATA_HOME/monday-task-bridge`, or `~/.local/share/monday-task-bridge` |

`MONDAY_BRIDGE_DATA_DIR` can override the directory for the bridge, pairing CLI, and MCP process; all three must use the same value. On each new snapshot, the store prunes toward **200 snapshots / 7 days** and deletes image files no longer referenced by retained snapshots. Old files are not pruned while no new reads occur. Protect access to your OS account and never commit the data directory or token files.

## Limits and troubleshooting

- **`BROWSER_OFFLINE` or `extensionConnected: false`:** Start the bridge, check that the popup's power button is on, and use **Retry connection** if needed. Chrome must be running.
- **"Not signed in to `<account>`.monday.com":** Sign in to monday in the Chrome profile that has the extension, then retry.
- **"monday API: …":** monday rejected the request; the message is monday's. A task you cannot see in monday returns "monday has no task … that this account can see".
- **`CAPTURE_TIMEOUT`:** A read did not finish within 180 seconds. Check the popup error and retry.
- **`NO_SNAPSHOT`:** No cached task matches the requested IDs, or the MCP process could not obtain a read. Check `monday_bridge_status` first.
- **`INVALID_TARGET`:** The URL is not a `https://<account>.monday.com/boards/<id>/pulses/<id>` task link, or no account host is known for a board and item ID.
- **No task tab found:** Call `monday_read_task` with the task URL instead of `monday_read_open_task`.
- **Image unavailable:** Only PNG, JPEG, GIF, and WebP originals are accepted after byte-level validation; other files are listed in the `Other files` field. Images over **25 MB each** or **75 MB per read** are not returned. If an image is stored outside monday's usual file storage, the popup asks to allow that host once; grant it only if you recognize the host.
- **More than 100 updates:** Only the latest 100 are read, and the snapshot says so in `warnings`.
- **Pairing fails or expires:** Tap the power button again and approve the new code within two minutes. Pairing a different extension ID replaces the previous pairing; the old extension must pair again to reconnect.
- **Popup says the bridge no longer accepts this browser:** Another pairing replaced this one, or the bridge is using a different data directory. Pair again.

When reporting a failure, include the task URL shape, popup error, and snapshot warnings. Do not include session cookies, bridge tokens, or private task content in a public issue.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

The Chrome extension lives in `extension/` (the API mapping is in `extension/helpers/monday-api.ts`), the local HTTP/WebSocket receiver and MCP server in `bridge/`, and shared payload types in `shared/`. CI runs install, typecheck, tests, and build on Node.js 24. Generated files in `dist/` are intentionally not committed.
