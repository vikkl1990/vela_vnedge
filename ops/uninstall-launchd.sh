#!/bin/zsh
# Stop the VNEdge launchd agent (graceful SIGTERM, then launchd's ExitTimeOut) and remove the plist.
set -euo pipefail
LABEL="${LABEL:-com.vnedge.server}"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "stopped $LABEL" || echo "$LABEL was not running"
if [[ -f "$PLIST_DST" ]]; then rm -f "$PLIST_DST"; echo "removed $PLIST_DST"; fi
