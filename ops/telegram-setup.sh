#!/usr/bin/env bash
# Install the Telegram alert channel for the vnedge service (decision 168).
#
# Run it yourself on the VM, in your own terminal:
#   ssh -t -i ~/.ssh/cryptobot_oci ubuntu@161.118.252.185 'sudo bash /opt/vnedge/ops/telegram-setup.sh'
#
# The bot token is typed here, hidden, and goes only to Telegram and to a root-only systemd drop-in. It is never put on
# a command line (curl reads the URL from stdin), never logged and never printed.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }

DROPIN=/etc/systemd/system/vnedge.service.d/telegram.conf
LOG=/opt/vnedge/data/logs/vnedge.log

tg() {  # tg METHOD [curl args...]: call the Bot API without the token appearing in the process list
  local method=$1; shift
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TOKEN" "$method" | curl -fsS --max-time 20 -K - "$@"
}

read -rsp "Telegram bot token from @BotFather (input hidden): " TOKEN; echo
# a paste often carries spaces, a newline or the "bot" prefix from the API URL; keep only the token itself
TOKEN=$(printf "%s" "$TOKEN" | tr -d "[:space:]" | sed -E "s/^(HTTP API:)?(bot)?//")
[[ "$TOKEN" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "That does not look like a bot token (digits:letters)."; exit 1; }

ME=$(tg getMe) || { echo "Telegram refused the token. Check it in @BotFather and run again."; exit 1; }
BOT=$(python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["username"])' <<<"$ME")
echo "Bot found: @$BOT"
echo
echo "Open Telegram, find @$BOT, press Start (or send it any message), then press Enter here."
read -r _

UPD=$(tg getUpdates)
CHAT=$(python3 - "$UPD" <<'PY'
import json, sys
res = json.loads(sys.argv[1]).get("result", [])
for u in reversed(res):
    m = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
    c = m.get("chat")
    if c and "id" in c:
        who = c.get("username") or c.get("title") or c.get("first_name") or ""
        print(f'{c["id"]}\t{who}')
        break
PY
)
[ -n "$CHAT" ] || { echo "No message to @$BOT seen yet. Send it one and run this again."; exit 1; }
CHAT_ID=${CHAT%%$'\t'*}; WHO=${CHAT#*$'\t'}
echo "Alerts will go to chat $CHAT_ID ${WHO:+($WHO)}"

umask 077
mkdir -p "$(dirname "$DROPIN")"
printf '# Telegram alert channel (decision 168). Root-only: holds the bot token.\n[Service]\nEnvironment=TELEGRAM_BOT_TOKEN=%s\nEnvironment=TELEGRAM_CHAT_ID=%s\n' "$TOKEN" "$CHAT_ID" > "$DROPIN"
chown root:root "$DROPIN"; chmod 600 "$DROPIN"
echo "Saved to $DROPIN (root only)."

systemctl daemon-reload
systemctl restart vnedge
echo "Restarting the bot..."
for _ in $(seq 1 30); do
  sleep 1
  line=$(grep '"ops started' "$LOG" 2>/dev/null | tail -1 || true)
  case "$line" in *"alerts via"*) break ;; esac
done
case "${line:-}" in
  *"alerts via"*) echo "The bot reports: alerts configured." ;;
  *) echo "The bot did not report the alert channel yet; check the Gates page in a minute." ;;
esac

if tg sendMessage -o /dev/null --data-urlencode "chat_id=$CHAT_ID" --data-urlencode "text=✅ VNEdge alerts connected ($(hostname), $(date -u '+%Y-%m-%d %H:%M') UTC). Halts, stranded positions and hunt results will arrive here."; then
  echo "Test message sent. Check Telegram."
else
  echo "Sending the test message failed; the settings are saved, check the bot in Telegram."
fi
unset TOKEN
