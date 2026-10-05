#!/usr/bin/env bash
# Deploy main to the VM the one way it is done (decision 80): tests and lint locally, push, pull on the VM,
# build the dashboard, restart. Refuses when the service restarted within the last six hours, because every
# restart re-warms the fleet and costs minutes of closes — batch changes. `--force` overrides.
set -euo pipefail
VM=${VM:-ubuntu@161.118.252.185}; KEY=${KEY:-~/.ssh/cryptobot_oci}; FORCE=${1:-}
cd "$(dirname "$0")/.."
echo "== local checks"; (cd server && npm test 2>&1 | grep -E "^ℹ (pass|fail)"); (cd dashboard && npm run lint >/dev/null && npm run build 2>&1 | grep "✓ built")
test -z "$(git status --porcelain --untracked-files=no)" || { echo "working tree has uncommitted changes"; exit 1; }
git push -q origin main
LAST=$(ssh -i "$KEY" "$VM" 'systemctl show vnedge -p ActiveEnterTimestampMonotonic --value; cat /proc/uptime' | awk 'NR==1{s=$1/1e6} NR==2{print int($1 - s)}')
if [ "$FORCE" != "--force" ] && [ "$LAST" -lt 21600 ]; then echo "refused: the service restarted $((LAST/60)) min ago; batch changes or pass --force"; exit 2; fi
ssh -i "$KEY" "$VM" 'cd /opt/vnedge && git pull -q --ff-only && echo "behind: $(git rev-list --count HEAD..origin/main)" && cd dashboard && npm run build 2>&1 | tail -1 && sudo systemctl restart vnedge && sleep 45 && systemctl is-active vnedge && curl -s -o /dev/null -w "api %{http_code}\n" -m 5 http://127.0.0.1:8787/api/health'
