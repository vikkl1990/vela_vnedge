#!/usr/bin/env bash
# systemd opens StandardOutput=append files as root. Open them as the service
# user instead, preserving copytruncate's inode and keeping new files private.
set -euo pipefail
case "${1:-}" in vnedge|incubate|library-sync) log_name=$1;; *) echo 'Unknown VN EDGE service' >&2; exit 2;; esac
shift
[ "$#" -gt 0 ] || { echo 'Missing service command' >&2; exit 2; }
umask 077
data_dir=${VNEDGE_DATA_DIR:-/opt/vnedge/data}
log_dir=$data_dir/logs
[ ! -L "$data_dir" ] && [ ! -L "$log_dir" ] || { echo 'Refusing a symlinked data/log directory' >&2; exit 1; }
mkdir -p -m 700 "$log_dir"
for suffix in out err; do
  log_file=$log_dir/$log_name.$suffix
  [ ! -L "$log_file" ] || { echo 'Refusing a symlinked service log' >&2; exit 1; }
  if [ -e "$log_file" ]; then
    [ -f "$log_file" ] && [ -O "$log_file" ] || { echo 'Service logs must be regular files owned by the service user' >&2; exit 1; }
    chmod 600 "$log_file"
  fi
done
exec "$@" >>"$log_dir/$log_name.out" 2>>"$log_dir/$log_name.err"
