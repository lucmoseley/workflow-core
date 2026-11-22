#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "error: run as root: sudo bash $0" >&2
  exit 1
}

for unit in fstrim.timer fstrim.service; do
  dir="/etc/systemd/system/${unit}.d"
  mkdir -p "$dir"
  cat >"$dir/wsl.conf" <<'CONF'
# workflow-core#5044: systemd counts WSL as a container, which the stock
# unit's ConditionVirtualization=!container refuses. Empty resets it.
[Unit]
ConditionVirtualization=
CONF
done
systemctl daemon-reload
systemctl enable fstrim.timer
systemctl restart fstrim.timer
systemctl list-timers fstrim.timer
