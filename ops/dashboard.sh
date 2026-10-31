#!/usr/bin/env bash
# Access the VM dashboard over an authenticated SSH tunnel, bound only to loopback.
set -euo pipefail
VM=${VM:-ubuntu@161.118.252.185}
KEY=${KEY:-$HOME/.ssh/cryptobot_oci}
PORT=${PORT:-18787}
printf 'Dashboard: http://localhost:%s (leave this terminal running)\n' "$PORT"
exec ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "$KEY" -N -L "127.0.0.1:$PORT:127.0.0.1:8787" "$VM"
