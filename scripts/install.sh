#!/usr/bin/env bash
# Monday Task Bridge installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.sh | bash
#
# Downloads (or updates) the bridge, builds it, registers the MCP server with every agent CLI it finds
# (Claude Code, Codex, agy), starts the bridge, then walks through loading the Chrome extension and pairing.
# Run it again to update. Optional environment variables:
#   MONDAY_BRIDGE_HOME     install folder (default: ~/.monday-task-bridge)
#   MONDAY_BRIDGE_CLIENTS  agent CLIs to register, comma-separated (default: claude,codex,agy; "none" registers none)
#   MONDAY_BRIDGE_APPROVAL auto (default: agents read monday without asking each time) or manual (they ask)

set -euo pipefail

REPO=https://github.com/nathanpixodeo/monday-task-bridge.git
NAME=monday-task-bridge

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mInstall failed: %s\033[0m\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

step 'Checking requirements'
have git || fail 'Git is required.'
have node || fail 'Node.js 22.12 or newer is required: https://nodejs.org'
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' ||
  fail "Node.js 22.12 or newer is required (found $(node -v)): https://nodejs.org"
have npm || fail 'npm was not found next to Node.js. Reinstall Node.js from https://nodejs.org'
echo "  Node.js $(node -v), $(git --version)"

# Run from a checkout (bash scripts/install.sh), the installer uses that checkout as it is.
dir=${MONDAY_BRIDGE_HOME:-}
use_checkout=0
script_path=${BASH_SOURCE[0]:-}
if [ -z "$dir" ] && [ -n "$script_path" ] && [ -f "$(dirname "$script_path")/../bridge/mcp.ts" ]; then
  dir=$(cd "$(dirname "$script_path")/.." && pwd)
  use_checkout=1
fi
dir=${dir:-$HOME/.monday-task-bridge}

if [ "$use_checkout" = 1 ]; then
  step "Using this checkout: $dir"
elif [ -d "$dir/.git" ]; then
  step "Updating $dir"
  git -C "$dir" pull --ff-only
elif [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  fail "$dir is not empty and is not a git checkout. Remove it, or set MONDAY_BRIDGE_HOME to another folder."
else
  step "Downloading into $dir"
  git clone --depth 1 "$REPO" "$dir"
fi

step 'Installing dependencies and building'
(cd "$dir" && npm ci --no-audit --no-fund && npm run build)

mcp="$dir/dist/bridge/mcp.js"
clients=",$(printf %s "${MONDAY_BRIDGE_CLIENTS:-claude,codex,agy}" | tr -d ' ' | tr '[:upper:]' '[:lower:]'),"

step 'Registering the MCP server'
for client in claude codex agy; do
  case $clients in *",$client,"*) ;; *) continue ;; esac
  if ! have "$client"; then
    echo "  $client: not installed, skipped"
    continue
  fi
  case $client in
    claude)
      claude mcp remove -s user "$NAME" >/dev/null 2>&1 || true
      claude mcp add -s user "$NAME" -- node "$mcp"
      ;;
    codex)
      codex mcp remove "$NAME" >/dev/null 2>&1 || true
      codex mcp add "$NAME" -- node "$mcp"
      ;;
    agy)
      agy mcp add "$NAME" node "$mcp"
      ;;
  esac
  printf '  \033[32m%s: registered\033[0m\n' "$client"
done

approval=${MONDAY_BRIDGE_APPROVAL:-auto}
step "Approval mode: $approval"
node "$dir/dist/bridge/approval-cli.js" "$approval" ||
  printf '  \033[33mThe approval mode was not applied everywhere (see above). The agents will ask before each read.\033[0m\n'

step 'Starting the bridge'
node "$dir/dist/bridge/start-cli.js"
pair_cli="$dir/dist/bridge/pair-cli.js"
extension="$dir/dist/extension"

step 'Chrome extension'
if node -e 'fetch("http://127.0.0.1:3457/health").then((r) => r.json()).then((h) => process.exit(h.paired && h.extensionConnected ? 0 : 1), () => process.exit(1))'; then
  echo '  Already paired and connected.'
  echo '  After an update, click Reload on the Monday Task Bridge card in chrome://extensions.'
else
  copied=''
  if have pbcopy; then printf %s "$extension" | pbcopy && copied=' (copied to the clipboard)'; fi
  if [ "$(uname)" = Darwin ]; then
    open -a 'Google Chrome' 'chrome://extensions' >/dev/null 2>&1 || true
  elif have google-chrome; then
    (google-chrome 'chrome://extensions' >/dev/null 2>&1 &)
  fi
  echo '  In the Chrome profile that is signed in to monday.com:'
  echo '  1. Open chrome://extensions and turn on Developer mode.'
  echo "  2. Click Load unpacked and choose this folder$copied:"
  printf '       \033[33m%s\033[0m\n' "$extension"
  echo '     Already loaded? Click Reload on its card instead.'
  echo '  3. Open the extension popup and tap the power button. It shows a 6-digit code.'
  while true; do
    printf '  Enter the code here (or press Enter to pair later): '
    # Piped through curl, stdin is this script: read the code from the terminal.
    code=''
    { read -r code </dev/tty; } 2>/dev/null || code=''
    code=$(printf %s "$code" | tr -d '[:space:]')
    if [ -z "$code" ]; then
      echo '  To pair later, run:'
      printf '    \033[33mnode "%s" <code>\033[0m\n' "$pair_cli"
      break
    fi
    case $code in
      [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *) printf '  \033[31mThe code has 6 digits.\033[0m\n'; continue ;;
    esac
    if node "$pair_cli" "$code"; then break; fi
    printf '  \033[31mPairing failed. Tap the power button again for a new code.\033[0m\n'
  done
fi

step 'Done'
echo "  Installed in $dir"
echo '  Restart open Claude Code, Codex, or agy sessions to load the monday tools.'
echo '  To update, run the install command again, then click Reload on the extension card.'
