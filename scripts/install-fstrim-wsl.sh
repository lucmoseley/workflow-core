#!/usr/bin/env bash
# Lets the stock weekly fstrim.timer fire under WSL (#5044). Run as root:
#
#   sudo bash scripts/install-fstrim-wsl.sh
#
# Both fstrim units carry `ConditionVirtualization=!container`, and systemd
# counts WSL as a container.
# A drop-in setting the condition empty resets it, per systemd.unit(5).
#
# The weekly trim keeps the disk's free blocks known between the monthly
# compactions; check-wsl-disk.js warns when it has not fired in 14 days.
# Idempotent. Remove with:
#   sudo rm -r /etc/systemd/system/fstrim.{timer,service}.d && sudo systemctl daemon-reload

set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "error: run as root: sudo bash $0" >&2
  exit 1
}

for unit in fstrim.timer fstrim.service; do
  dir="/etc/systemd/system/${unit}.d"
  mkdir -p "$dir"
  cat >"$dir/wsl.conf" <<'CONF'
# workflow-core #5044: systemd counts WSL as a container, which the stock
# unit's ConditionVirtualization=!container refuses. Empty resets it.
[Unit]
ConditionVirtualization=
CONF
done
systemctl daemon-reload
systemctl enable fstrim.timer
systemctl restart fstrim.timer
systemctl list-timers fstrim.timer
