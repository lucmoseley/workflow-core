#!/usr/bin/env bash
set -euo pipefail

# workflow-core#5687
NIGHTS=3
LAST_MORNING=2026-12-04

first_night=''
case "${1:-}" in
  --first-night) first_night="${2:?--first-night takes YYYY-MM-DD}" ;;
  '') ;;
  *)
    echo "usage: bash $0 [--first-night YYYY-MM-DD]" >&2
    exit 2
    ;;
esac
if [[ -z "$first_night" ]]; then
  if ((10#$(date +%H) < 23)); then first_night="$(date +%F)"; else first_night="$(date -d tomorrow +%F)"; fi
fi
if [[ ! "$first_night" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || ! date -d "$first_night" >/dev/null 2>&1; then
  echo "error: --first-night is not a date: $first_night" >&2
  exit 2
fi

last_night="$(date -d "$first_night + $((NIGHTS - 1)) day" +%F)"
if [[ ! "$last_night" < "$LAST_MORNING" ]]; then
  echo "error: the last night, $last_night, would have no 07:00 run to turn combining off; the last morning is $LAST_MORNING." >&2
  exit 2
fi

SRC_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SRC_DIR" == "${BASH_SOURCE[0]}" ]] && SRC_DIR=.
SRC_DIR="$(cd "$SRC_DIR" && pwd)"
PS="${WFC_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
DIAG_WSL="${WFC_DIAG_DIR:-/mnt/c/diag/5743}"
DIAG_WIN="$("${WFC_WSLPATH:-wslpath}" -w "$DIAG_WSL")"
[[ -x "$PS" ]] || {
  echo "error: Windows PowerShell not reachable - is this WSL with interop enabled?" >&2
  exit 1
}
[[ -f "$DIAG_WSL/on-bugcheck.ps1" ]] || {
  echo "error: $DIAG_WIN\\on-bugcheck.ps1 is absent - is workflow-core#5743's Verifier pass armed?" >&2
  exit 1
}

cp "$SRC_DIR/win-interop-watchdog/page-combining.ps1" "$DIAG_WSL/"
ps1="$DIAG_WIN\\page-combining.ps1"
check() { "$PS" -NoProfile -ExecutionPolicy Bypass -File "$ps1" -Check | tr -d '\r'; }
state="$(check)"
if [[ "$state" != ok ]]; then
  echo "Registering the elevated tasks ($state): accept the UAC prompt on the Windows desktop."
  rm -f "$DIAG_WSL/register.log"
  "$PS" -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}','-Register'" || true
  state="$(check)"
  [[ "$state" == ok ]] || {
    if [[ -f "$DIAG_WSL/register.log" ]]; then
      echo "error: the elevated registration failed: $(tr -d '\r' <"$DIAG_WSL/register.log")" >&2
    else
      echo "error: $state - was the UAC prompt declined?" >&2
    fi
    exit 1
  }
fi

repo="$(cd "$SRC_DIR/.." && git rev-parse --path-format=absolute --git-common-dir)"
repo="${repo%/.git}"
node_bin="$(command -v node)"
unit_path=""
for bin in node gh curl; do
  found="$(command -v "$bin")" || {
    echo "error: $bin is not on PATH; the trial needs it." >&2
    exit 1
  }
  unit_path+="${found%/*}:"
done
unit_path+="/usr/local/bin:/usr/bin:/bin"
for p in "$node_bin" "$repo" "$unit_path"; do
  [[ "$p" =~ ^[A-Za-z0-9_./@+:-]+$ ]] || {
    echo "error: cannot write a unit naming '$p': only plain path characters are taken." >&2
    exit 1
  }
done
[[ -f "$repo/scripts/combining-trial.js" ]] || {
  echo "error: $repo/scripts/combining-trial.js is absent - land workflow-core#5804 on main first." >&2
  exit 1
}

nights=""
for ((i = 0; i < NIGHTS; i++)); do
  nights+="OnCalendar=$(date -d "$first_night + $i day" +%F) 23:00"$'\n'
done
mornings=""
day="$(date -d "$first_night + 1 day" +%F)"
while [[ ! "$day" > "$LAST_MORNING" ]]; do
  mornings+="OnCalendar=$day 07:00"$'\n'
  day="$(date -d "$day + 1 day" +%F)"
done

SYSTEMCTL="${WFC_SYSTEMCTL:-systemctl}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
for run in night morning; do
  # guess, workflow-core#5804: a night ends at 07:00; a morning waits up to 65 min, then scans
  if [[ "$run" == night ]]; then limit=9h; else limit=3h; fi
  cat >"$unit_dir/combining-trial-$run.service" <<UNIT
[Unit]
Description=Page combining trial, $run run (workflow-core#5804)

[Service]
Type=oneshot
Environment=PATH=$unit_path
WorkingDirectory=$repo
ExecStart=$node_bin $repo/scripts/combining-trial.js $run
TimeoutStartSec=$limit
UNIT
done
cat >"$unit_dir/combining-trial-night.timer" <<UNIT
[Unit]
Description=Turn page combining on at 23:00 on the trial's nights (workflow-core#5804)

[Timer]
${nights}# A night missed is skipped: turning combining on late would run past 07:00.
Persistent=false
AccuracySec=1min

[Install]
WantedBy=timers.target
UNIT
cat >"$unit_dir/combining-trial-morning.timer" <<UNIT
[Unit]
Description=Live dump, then page combining off, at 07:00 each trial morning (workflow-core#5804)

[Timer]
${mornings}# A morning missed runs at the next boot, which turns combining off.
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
UNIT
"$SYSTEMCTL" --user daemon-reload
"$SYSTEMCTL" --user enable --now combining-trial-night.timer combining-trial-morning.timer
"$SYSTEMCTL" --user list-timers 'combining-trial-*' --no-pager

cat <<EOF

Installed: combining on at 23:00 on $NIGHTS nights from $first_night; a live dump, then
combining off, at 07:00 each morning to $LAST_MORNING, each dump's PFN scan posted on workflow-core#5743.

  Logs        : $DIAG_WIN\\combining.log, $DIAG_WIN\\dumps.log; journalctl --user -u 'combining-trial-*'
  Dumps       : $DIAG_WIN\\dumps\\ (each with its .pfnscan.json)
  Remove with : systemctl --user disable --now combining-trial-night.timer combining-trial-morning.timer
                schtasks.exe /Delete /TN "Verifier 5743 combining on" /F   (likewise "... combining off", "... live dump")
EOF
