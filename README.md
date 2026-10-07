# Monday Task Bridge

A local Chrome extension and MCP bridge for reading monday.com tasks through the Chrome session you already use. It does not require a monday API token or an admin-installed monday app. The bridge can only read information your signed-in account can see in the web UI.

## How it works

1. The extension notices when you open an item in monday.com.
2. It opens a temporary background tab, expands the available updates and Files view, and sends a snapshot with original image bytes to a server on `127.0.0.1:3457`.
3. The local MCP server serves those snapshots to your AI agent. `monday_read_open_task` asks the extension for a fresh capture.

The extension uses UI-visible data and download links. It does not read cookies, call monday's private API, or edit tasks. If it cannot retrieve an original image or finish loading the task, the snapshot reports an error instead of claiming to be complete.

## Install locally

Requires Node.js 22.12+ and Chrome with permission to load an unpacked extension.

```powershell
npm ci
npm run build
npm run bridge
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `dist/extension` directory. Open the extension popup and click **Start Pairing** to display a short code. In another terminal run:

```powershell
npm run pair -- 123456
```

Replace `123456` with the code shown in the popup. Open a monday task after pairing. The popup shows sync status and any image permission or extraction errors. If an image needs an extra host permission, allow it in the popup and reopen the task to retry. Leave the bridge process running while browsing. After rebuilding the extension, click **Reload** for it on `chrome://extensions`.

For a quick MCP run from this checkout, use `npm run mcp`. For Codex or Claude Code, configure a stdio MCP server with command `node` and argument `<absolute-path-to-repo>/dist/bridge/mcp.js` after `npm run build`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `monday_read_open_task` | Ask the extension to capture the currently open task now. |
| `monday_get_task` | Read the latest or a named cached task snapshot. |
| `monday_get_image` | Return the original attached image to the agent. |
| `monday_list_tasks` | List locally captured tasks. |
| `monday_bridge_status` | Check connection, latest capture and errors. |

Snapshots and images are stored in `%LOCALAPPDATA%\monday-task-bridge` on Windows, outside this repository. The local receiver binds only to loopback and requires a separate bridge token. Tokens must never be committed to Git.

## Limits

Capture is limited to tasks accessible through the current monday account and depends on monday's web interface. Guest permissions remain in force. Some updates are loaded only after scrolling and some original image downloads may require an additional Chrome site permission; the popup reports these cases. PNG, JPEG, GIF and WebP originals are supported; other file formats are reported as unavailable. The project does not crawl boards or access tasks that are not visible to the signed-in user.

Run `npm run typecheck`, `npm test`, and `npm run build` before packaging or changing the extractor.
