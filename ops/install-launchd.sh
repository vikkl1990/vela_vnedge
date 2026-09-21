#!/bin/zsh
# Install (or reinstall) VNEdge as a launchd user agent that starts at login and restarts on exit.
#
#   ops/install-launchd.sh            install + start
#   ops/install-launchd.sh --restart  restart a running agent (after a git pull)
#   ops/install-launchd.sh --status   show whether it is running
#   ops/uninstall-launchd.sh          stop + remove
#
# Environment overrides: PORT, HOST, NODE (path to the node binary), LABEL (default com.vnedge.server).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${LABEL:-com.vnedge.server}"
PLIST_SRC="$ROOT/ops/launchd/com.vnedge.server.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE:-$(command -v node || true)}"
DOMAIN="gui/$(id -u)"

status() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|pid =|last exit code' || echo "$LABEL is not loaded"; }

case "${1:-}" in
  --status) status; exit 0 ;;
  --restart) launchctl kickstart -k "$DOMAIN/$LABEL"; sleep 1; status; exit 0 ;;
esac

[[ -x "$NODE_BIN" ]] || { echo "node not found; set NODE=/path/to/node" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || { echo "Node >= 22.18 required, found $("$NODE_BIN" -v)" >&2; exit 1; }
[[ -d "$ROOT/node_modules" ]] || { echo "run 'npm install' in $ROOT first" >&2; exit 1; }
[[ -d "$ROOT/dashboard/dist" ]] || echo "note: dashboard/dist missing — run 'npm run build' for the UI (the API works without it)"

mkdir -p "$ROOT/data/logs" "$HOME/Library/LaunchAgents"
sed -e "s#__ROOT__#$ROOT#g" -e "s#__NODE_DIR__#$(dirname "$NODE_BIN")#g" -e "s#__HOME__#$HOME#g" "$PLIST_SRC" > "$PLIST_DST"
if [[ -n "${PORT:-}" ]]; then /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:PORT $PORT" "$PLIST_DST"; fi
if [[ -n "${HOST:-}" ]]; then /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:HOST $HOST" "$PLIST_DST"; fi
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TELEGRAM_BOT_TOKEN string $TELEGRAM_BOT_TOKEN" "$PLIST_DST"
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TELEGRAM_CHAT_ID string $TELEGRAM_CHAT_ID" "$PLIST_DST"
  chmod 600 "$PLIST_DST"
  echo "Telegram credentials written to $PLIST_DST (mode 600)"
fi
plutil -lint "$PLIST_DST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl enable "$DOMAIN/$LABEL"
sleep 1
echo "installed $PLIST_DST"
status
echo "logs: $ROOT/data/logs/vnedge.log (rotated), launchd.out.log / launchd.err.log"
echo "health: curl -s http://127.0.0.1:${PORT:-8787}/api/health | head -c 300"
