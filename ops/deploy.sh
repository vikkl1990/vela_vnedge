#!/usr/bin/env bash
# Deploy the commit that was tested (decision 80, hardened in decision 82): checks locally, push, check out that exact
# SHA on the VM, install dependencies when the lockfile changed, build the dashboard, and only then restart; require
# the API to answer afterwards. Refuses within six hours of the last restart unless --force.
set -euo pipefail
VM=${VM:-ubuntu@161.118.252.185}; KEY=${KEY:-~/.ssh/cryptobot_oci}; FORCE=${1:-}
cd "$(dirname "$0")/.."
test -z "$(git status --porcelain --untracked-files=no)" || { echo "working tree has uncommitted changes"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "deploy from main only"; exit 1; }
SHA=$(git rev-parse HEAD)
echo "== local checks on $SHA"; (cd server && npm test 2>&1 | grep -E "^ℹ (pass|fail)" | tr '\n' ' '; echo); (cd server && npm test 2>&1 | grep -q "^ℹ fail 0") || { echo "tests failed"; exit 1; }
(cd dashboard && npm run lint >/dev/null && npm run build 2>&1 | grep "✓ built")
git push -q origin main
LAST=$(ssh -i "$KEY" "$VM" 'systemctl show vnedge -p ActiveEnterTimestampMonotonic --value; cat /proc/uptime' | awk 'NR==1{s=$1/1e6} NR==2{print int($1 - s)}')
if [ "$FORCE" != "--force" ] && [ "$LAST" -lt 21600 ]; then echo "refused: the service restarted $((LAST/60)) min ago; batch changes or pass --force"; exit 2; fi
ssh -i "$KEY" "$VM" "bash -s $SHA" <<'REMOTE'
set -euo pipefail
SHA=$1
cd /opt/vnedge
OLD=$(git rev-parse HEAD)
git fetch -q origin && git checkout -q --detach "$SHA" && git branch -f main "$SHA" && git checkout -q main
echo "VM now at $(git rev-parse --short HEAD) (was $(git rev-parse --short "$OLD"))"
if ! git diff --quiet "$OLD" "$SHA" -- package-lock.json server/package.json dashboard/package.json; then echo "lockfile changed: npm ci"; npm ci --ignore-scripts >/tmp/npm-ci.log 2>&1 || { tail -20 /tmp/npm-ci.log; exit 1; }; fi
(cd dashboard && npm run build >/tmp/dashboard-build.log 2>&1) || { echo "dashboard build FAILED, not restarting"; tail -20 /tmp/dashboard-build.log; exit 1; }
tail -1 /tmp/dashboard-build.log
sudo systemctl restart vnedge
for i in $(seq 1 24); do sleep 5; code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8787/api/health || true); [ "$code" = "401" ] || [ "$code" = "200" ] && break; done
systemctl is-active vnedge && echo "api $code"
[ "$code" = "401" ] || [ "$code" = "200" ] || { echo "API did not come up"; exit 1; }
REMOTE
