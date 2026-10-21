# Monday Task Bridge

English · [Français](README.fr.md) · [Tiếng Việt](README.vi.md)

Author: **Nhat Nguyen** · Developed by **Nexkit** · [nathanpixodeo@gmail.com](mailto:nathanpixodeo@gmail.com)

Let an AI agent (Claude Code, Codex, agy, or any MCP client) read monday.com tasks, with their updates and original images, through **your signed-in Chrome**. You need no monday API token, no admin-installed app, and no monday MCP plan: sign in to monday in Chrome once, and the extension does the rest.

It has two parts that run on your PC:

- **A Chrome extension** that reads tasks with your monday session.
- **A local bridge with an MCP server** that your agent talks to. The bridge listens on `127.0.0.1:3457` only.

> **Project status:** Personal prototype. Typecheck, build, and automated tests pass in CI, and reading tasks has been checked against real monday tasks. Treat `complete` as a best-effort signal and read `warnings` before relying on a snapshot.

## Quick start

You need:

- Google Chrome, signed in to monday.com
- [Node.js](https://nodejs.org) 22.12 or newer, and [Git](https://git-scm.com)
- At least one agent CLI: Claude Code, Codex, or agy

### 1. Run the installer

Open a terminal and run one command.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.sh | bash
```

The installer:

- downloads the code and builds it,
- registers the MCP server with every agent CLI it finds (Claude Code, Codex, agy); you do not run any `mcp add` command yourself,
- lets those CLIs read monday without asking you each time ([approval mode](#approval-mode-auto-or-manual) `auto`),
- starts the bridge,
- opens `chrome://extensions` and waits for you to load the extension and pair it (steps 2 and 3).

Keep the terminal open until it says **Done**.

### 2. Load the extension in Chrome

Do this in the Chrome profile that is signed in to monday.com.

1. Open `chrome://extensions` (the installer opens it for you).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the extension folder. The installer copies its path to the clipboard (on Windows and macOS):

   | OS | Extension folder |
   | --- | --- |
   | Windows | `%LOCALAPPDATA%\Programs\monday-task-bridge\dist\extension` |
   | macOS / Linux | `~/.monday-task-bridge/dist/extension` |

4. Pin **Monday Task Bridge** to the toolbar so its popup is one click away.

### 3. Pair the extension with the bridge

1. Open the extension popup and tap the **power button**. The popup shows a 6-digit code.
2. Type that code into the installer terminal and press Enter.
3. The popup says **Connected**. The installer finishes with **Done**.

The code expires after two minutes. If it expires, tap the power button again for a new code.

### 4. Restart your agent and try it

Restart any Claude Code, Codex, or agy session that was already open, so it loads the new tools. Check that the server is there:

```powershell
claude mcp list    # or: codex mcp list / agy mcp list
```

`monday-task-bridge` must be in the list (Claude Code shows `✔ Connected`). Then ask your agent, for example:

> Read this monday task: https://your-team.monday.com/boards/123/pulses/456

> List the monday tasks assigned to me.

Chrome must be running, with the extension's power button on, whenever an agent reads monday.

## Update, pair again, uninstall

**Update:** run the install command again. Then click **Reload** on the Monday Task Bridge card in `chrome://extensions`.

**Pair again** (after **Unpair**, a new Chrome profile, or an expired code): run the install command again; it asks for a new code whenever the extension is not connected. To pair without reinstalling, run the pair helper with the code from the popup:

```powershell
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\pair-cli.js" 123456
```

```sh
node ~/.monday-task-bridge/dist/bridge/pair-cli.js 123456
```

The popup also shows `npm run pair -- <code>`. That command works only inside the install folder.

**Another Claude Code profile:** Claude Code keeps its settings per profile. Point `CLAUDE_CONFIG_DIR` at the other profile and run the installer again:

```powershell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-profiles\other-profile"
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

**Uninstall:**

1. Remove the approval rules, then the MCP server, from each agent CLI:

   ```powershell
   node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" manual
   claude mcp remove -s user monday-task-bridge
   codex mcp remove monday-task-bridge
   agy mcp remove monday-task-bridge
   ```

   On macOS/Linux, the first line is `node ~/.monday-task-bridge/dist/bridge/approval-cli.js manual`.

2. Click **Remove** on the extension card in `chrome://extensions`.
3. Delete the install folder: `%LOCALAPPDATA%\Programs\monday-task-bridge` on Windows, `~/.monday-task-bridge` on macOS/Linux.
4. Delete the data folder (see [Local data and privacy](#local-data-and-privacy)).
5. Restart the PC to stop a bridge that is still running.

### Installer options

Set these environment variables before you run the installer:

| Variable | Effect |
| --- | --- |
| `MONDAY_BRIDGE_HOME` | Install into another folder. |
| `MONDAY_BRIDGE_CLIENTS` | Agent CLIs to register, comma-separated. The default is `claude,codex,agy`; `none` registers none. |
| `MONDAY_BRIDGE_APPROVAL` | `auto` (default) or `manual`; see [Approval mode](#approval-mode-auto-or-manual). |
| `CLAUDE_CONFIG_DIR` | The Claude Code profile to register with. |

## Approval mode: auto or manual

By default, an agent CLI asks you to approve every MCP tool call, so each monday read stops at a yes/no prompt. The approval mode decides this for the bridge's tools in Claude Code, Codex, and agy at once:

- **`auto`**: the agent reads tasks, boards, and images without asking. The installer sets this mode.
- **`manual`**: the agent asks before each read, as the CLIs do by default.

Switch at any time, then restart open agent sessions:

```powershell
# Windows
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" auto
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" manual
node "$env:LOCALAPPDATA\Programs\monday-task-bridge\dist\bridge\approval-cli.js" status
```

```sh
# macOS / Linux
node ~/.monday-task-bridge/dist/bridge/approval-cli.js auto
```

From a source checkout, `npm run approval -- auto` does the same.

`auto` covers the read tools only. `monday_write_back` always asks. The command writes these rules, and `manual` removes them again:

| CLI | File | Rule for each read tool |
| --- | --- | --- |
| Claude Code | `settings.json` in the profile folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`) | `permissions.allow`: `mcp__monday-task-bridge__monday_read_task` |
| Codex | `config.toml` in `~/.codex` (or `CODEX_HOME`) | `[mcp_servers.monday-task-bridge.tools.monday_read_task]` with `approval_mode = "approve"` |
| agy | `~/.gemini/antigravity-cli/settings.json` | `permissions.allow`: `mcp(monday-task-bridge/monday_read_task)` |

`MONDAY_BRIDGE_CLIENTS` limits the CLIs the command changes. For another Claude Code profile, set `CLAUDE_CONFIG_DIR` first, as for the installer.

## What your agent can do

| MCP tool | Result |
| --- | --- |
| `monday_read_task` | A fresh read of any task, by `url` or by `boardId` + `itemId` (optional `accountHost`). You do not need to open the task. |
| `monday_read_open_task` | A fresh read of the task open in your active Chrome tab, or in the first open task tab. |
| `monday_list_assigned_tasks` | A live list of the tasks assigned to you (any people column), with board, link, and columns. Optional `boardIds` reads only those boards. It checks up to 100 active boards and 5000 tasks (items and subitems) within 160 seconds. `complete` is false, and `warnings` say why, when a limit or an unreadable board cut the list. Not cached. |
| `monday_list_boards` | The active boards you can be assigned on, with their workspace, to use as `boardIds` above. |
| `monday_get_image` | The original PNG, JPEG, GIF, or WebP bytes of an attachment whose status is `ready`. |
| `monday_get_task` | The latest cached snapshot, optionally filtered by `boardId` and/or `itemId`. |
| `monday_list_tasks` | Summaries of the cached snapshots. |
| `monday_bridge_status` | Bridge health, pairing, and extension connection state. |

A typical agent flow is: call `monday_read_task` with the task link, read `complete` and `warnings`, then call `monday_get_image` for each attachment it needs to see.

The tools only read. The one exception is `monday_write_back`, which adds an update to an item and can set its Status. Agents never see this tool unless their MCP client starts the server with `MONDAY_BRIDGE_ALLOW_WRITE=1`. The installer does not set it.

## The extension popup

The **power button** turns the connection on and off. While it is off, reads fail with `BROWSER_OFFLINE`. The toolbar icon is in color while connected and grey otherwise. A badge flags anything that needs attention:

| Badge | Meaning |
| --- | --- |
| `…` (violet) | Reading a task, or waiting for pairing approval. |
| `!` (red) | The connection is on, but the bridge is offline or not connected. |
| `!` (amber) | The last read is incomplete. Open the popup to read its warnings. |
| `+` (amber) | An image host needs permission. |
| none | Connected (color icon), or turned off or not paired (grey icon). |

## How it works

1. An agent calls an MCP tool. The MCP server (started by the agent CLI) passes the request to the bridge, and starts the bridge in the background if it is not running.
2. The bridge sends the request to the paired extension over a local WebSocket.
3. The extension calls **monday's own web API** (`https://<account>.monday.com/v2`, GraphQL): the same endpoint monday's web app uses, with your browser session and the app's CSRF token. One request returns the task name, every column as text, the updates with replies and authors, and the attached files. No tab opens.
4. Original images are downloaded from monday's file storage and checked byte by byte. Files that are not images are listed in an `Other files` field.
5. The snapshot goes back to the bridge, which caches it and returns it to the agent.

The extension never crawls boards, reads or exports cookie values, or replaces original images with screenshots. It can only see the tasks your monday account can see.

## Local data and privacy

The bridge listens on loopback only and rejects web pages. Pairing needs the 6-digit code to be approved on your PC. After that, the extension must send a bearer token from its own extension origin, and the MCP server uses a separate local admin token. **Unpair** in the popup revokes the extension token. Each new pairing issues a fresh token, so an old token stops working.

The CSRF token monday puts in its app page stays in the extension's memory and is never sent to the bridge. The extension has host access to `*.monday.com` and to monday's file storage (`files-monday-com.s3.amazonaws.com`) for original images.

Snapshots, images, and tokens are stored **unencrypted** in your user profile:

| OS | Data folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\monday-task-bridge` |
| macOS | `~/Library/Application Support/monday-task-bridge` |
| Linux | `$XDG_DATA_HOME/monday-task-bridge`, or `~/.local/share/monday-task-bridge` |

The bridge log is `bridge.log` in that folder. `MONDAY_BRIDGE_DATA_DIR` moves the folder; the bridge, the pair helper, and the MCP server must then all use the same value. Each new snapshot prunes the cache toward **200 snapshots / 7 days** and deletes images that no kept snapshot uses. Never commit or share this folder.

## Troubleshooting

### Installing and connecting the agent

- **`claude mcp list` shows `monday-task-bridge` as failed, or the agent reports `Cannot find module '...\dist\bridge\mcp.js'`:** The registered path is wrong, or the code was not built there. This often comes from a manual setup with a relative path, a PowerShell variable used in another shell, or backslashes typed in Git Bash. Run the install command again; it builds the code and registers the full path. If the old entry still shows, remove it with `claude mcp remove monday-task-bridge` from the folder where you added it, then run the installer again.
- **`Cannot find package '@modelcontextprotocol/sdk'` (or `ws`, `zod`):** The dependencies are missing, for example because only `dist` was copied to this PC. Run the install command again.
- **`irm` fails with "Could not create SSL/TLS secure channel" (older Windows 10):** Run `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` in the same window, then the install command again.
- **`npm.ps1 cannot be loaded because running scripts is disabled`:** PowerShell blocks npm's script shim. Use `npm.cmd` instead of `npm`. The installer already does.
- **"is not empty and is not a git checkout":** The install folder holds other files. Delete it, or set `MONDAY_BRIDGE_HOME` to another folder.
- **The agent does not list the monday tools:** Restart the agent session after installing.
- **The agent still asks before each monday read:** Run the approval command with `status`; it must say `auto` for that CLI. Then restart the agent session. In Codex, re-registering the server with `codex mcp remove` and `codex mcp add` drops the rules; run `auto` again.

### Reading tasks

- **`BROWSER_OFFLINE` or `extensionConnected: false`:** Chrome must be running, and the popup's power button must be on. Use **Retry connection** in the popup if needed.
- **"Not signed in to `<account>`.monday.com":** Sign in to monday in the Chrome profile that has the extension, then retry.
- **"monday API: …":** monday rejected the request; the message is monday's. A task you cannot see in monday returns "monday has no task … that this account can see".
- **`CAPTURE_TIMEOUT`:** A read did not finish within 180 seconds. Check the popup error and retry.
- **`NO_SNAPSHOT`:** No cached task matches the IDs, or the read failed. Call `monday_bridge_status` first.
- **`INVALID_TARGET`:** The URL is not a `https://<account>.monday.com/boards/<id>/pulses/<id>` task link, or no account is known for a board and item ID. Pass `accountHost`, or open monday in Chrome.
- **No task tab found:** Use `monday_read_task` with the task link instead of `monday_read_open_task`.
- **Image unavailable:** Only PNG, JPEG, GIF, and WebP originals are returned; other files are listed in `Other files`. Images over **25 MB each** or **75 MB per read** are skipped. If an image is stored outside monday's usual file storage, the popup asks to allow that host once. Allow it only if you recognize the host.
- **More than 100 updates:** Only the latest 100 are read, and `warnings` says so.
- **Pairing fails or expires:** Tap the power button again and enter the new code within two minutes. Pairing another extension (in another Chrome profile, or loaded from another folder) replaces the previous pairing.
- **The popup says the bridge no longer accepts this browser:** Another pairing replaced this one, or the bridge uses another data folder. Pair again.

To check the bridge without exposing a token, run `Invoke-RestMethod http://127.0.0.1:3457/health` (macOS/Linux: `curl http://127.0.0.1:3457/health`). `paired: true` means an extension is paired; `extensionConnected: true` means it is connected now. A live read needs both.

When you report a problem, include the task URL shape, the popup error, and the snapshot warnings. Do not post session cookies, bridge tokens, or private task content in a public issue.

## Manual setup (from source)

Use this for development, or if you cannot run the installer.

```powershell
git clone https://github.com/nathanpixodeo/monday-task-bridge.git
cd monday-task-bridge
npm ci
npm run build
node dist/bridge/start-cli.js
```

`start-cli.js` starts the bridge in the background (`npm run bridge` runs it in the foreground instead). Load `dist/extension` in Chrome as in step 2 of the quick start. Then tap the power button and approve the code from this folder with `npm run pair -- 123456`.

Register the MCP server with the **full path** of `dist/bridge/mcp.js`. The path must exist, so build first. Replace `C:\path\to\monday-task-bridge` with your folder:

```powershell
claude mcp add -s user monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
codex mcp add monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
agy mcp add monday-task-bridge node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
```

- Keep `-s user` for Claude Code. Without it, the server is registered for the current folder only.
- In Git Bash, write the path with forward slashes (`C:/path/to/...`). Bash removes unquoted backslashes.
- For any other MCP client, use a stdio server with `command` set to `node` and `args` set to the full path:

  ```json
  {
    "mcpServers": {
      "monday-task-bridge": {
        "command": "node",
        "args": ["C:/path/to/monday-task-bridge/dist/bridge/mcp.js"]
      }
    }
  }
  ```

No token goes into the client configuration: the MCP server reads its admin token from the data folder.

To read without a yes/no prompt each time, run `npm run approval -- auto` from this folder after registering (see [Approval mode](#approval-mode-auto-or-manual)).

## Development

```powershell
npm run typecheck
npm test
npm run build
```

The Chrome extension is in `extension/` (the API mapping is in `extension/helpers/monday-api.ts`), the bridge, MCP server, and CLIs (`pair-cli`, `start-cli`, `approval-cli`) are in `bridge/`, shared payload types are in `shared/`, and the installers are in `scripts/`. `npm run mcp` runs the MCP server from source. CI runs install, typecheck, tests, and build on Node.js 24. The build output in `dist/` is not committed.

The extension always uses port `3457`; keep that port free. It does not follow a custom `MONDAY_BRIDGE_PORT` value.
