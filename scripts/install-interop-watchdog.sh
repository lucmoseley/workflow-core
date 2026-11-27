#!/usr/bin/env bash
set -euo pipefail

TASK_NAME='WSL Interop Watchdog'
SRC_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SRC_DIR" == "${BASH_SOURCE[0]}" ]] && SRC_DIR=.
SRC_DIR="$(cd "$SRC_DIR/win-interop-watchdog" && pwd)"
PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
SCHTASKS='/mnt/c/Windows/System32/schtasks.exe'

[[ -x "$PS" ]] || {
  echo "error: Windows PowerShell not reachable - is this WSL with interop enabled?" >&2
  exit 1
}
[[ -x "$SCHTASKS" ]] || {
  echo "error: schtasks.exe not reachable." >&2
  exit 1
}

win_user="$(/mnt/c/Windows/System32/whoami.exe | tr -d '\r')"
win_sid="$("$PS" -NoProfile -Command \
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value' | tr -d '\r')"
win_profile="$("$PS" -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"

install_win="${win_profile}\\wsl-interop-watchdog"
install_wsl="$("$PS" -NoProfile -Command '$env:USERPROFILE' | tr -d '\r' |
  sed -e 's|\\|/|g' -e 's|^\([A-Za-z]\):|/mnt/\L\1|')/wsl-interop-watchdog"

echo "Windows user : $win_user"
echo "Install dir  : $install_win"

mkdir -p "$install_wsl"
cp "$SRC_DIR/watchdog.ps1" "$SRC_DIR/launcher.vbs" "$SRC_DIR/compact-disk.ps1" "$install_wsl/"

tmp_xml="$(mktemp)"
trap 'rm -f "$tmp_xml"' EXIT
# GNU sed reads \l in a replacement as an escape that lowercases the next character: https://www.gnu.org/software/sed/manual/html_node/The-_0022s_0022-Command.html
sed -e "s|@@USERDOMAINUSER@@|${win_user//\\/\\\\}|" \
  -e "s|@@USERSID@@|${win_sid}|" \
  -e "s|@@INSTALLDIR@@|${install_win//\\/\\\\}|" \
  "$SRC_DIR/task.xml.template" >"$tmp_xml"

{
  printf '\xff\xfe'
  iconv -f UTF-8 -t UTF-16LE "$tmp_xml"
} >"$install_wsl/task.xml"

"$SCHTASKS" /Create /TN "$TASK_NAME" /XML "${install_win}\\task.xml" /F

echo
"$PS" -NoProfile -Command "
	\$i = Get-ScheduledTaskInfo -TaskName '$TASK_NAME'
	'State       : ' + (Get-ScheduledTask -TaskName '$TASK_NAME').State
	'Interval    : ' + (Get-ScheduledTask -TaskName '$TASK_NAME').Triggers[1].Repetition.Interval
	'NextRunTime : ' + \$i.NextRunTime
" | tr -d '\r'

COMPACT_TASK='WSL Disk Compaction'
repo="$(cd "$SRC_DIR/../.." && git rev-parse --path-format=absolute --git-common-dir)"
repo="${repo%/.git}"
registered_args() {
  "$PS" -NoProfile -Command "\$t = Get-ScheduledTask -TaskName '$COMPACT_TASK' -ErrorAction SilentlyContinue; if (\$t) { \$t.Actions[0].Arguments }; exit 0" | tr -d '\r'
}
compact_ps1="${install_win}\\compact-disk.ps1"
compact_args=(-WslUser "$USER" -Repo "$repo")
want="$("$PS" -NoProfile -ExecutionPolicy Bypass -File "$compact_ps1" -PrintArgs "${compact_args[@]}" | tr -d '\r')"
have="$(registered_args)"
if [[ "$have" != "$want" ]]; then
  echo "Registering '$COMPACT_TASK' elevated: accept the UAC prompt on the Windows desktop."
  "$PS" -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${compact_ps1}','-Register','-WslUser','$USER','-Repo','$repo'" || true
  have="$(registered_args)"
  [[ "$have" == "$want" ]] || {
    echo "error: '$COMPACT_TASK' is not registered - was the UAC prompt declined?" >&2
    exit 1
  }
fi

node_bin="$(command -v node)"
unit_path=""
for bin in node claude gh; do
  found="$(command -v "$bin")" || {
    echo "error: $bin is not on PATH; the compaction run needs it." >&2
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
SYSTEMCTL="${WFC_SYSTEMCTL:-systemctl}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat >"$unit_dir/wsl-disk-compaction.service" <<UNIT
[Unit]
Description=Start the monthly WSL disk compaction once due and no session is live (workflow-core#5044)

[Service]
Type=oneshot
Environment=PATH=$unit_path
WorkingDirectory=$repo
ExecStart=$node_bin $repo/scripts/wsl-disk-compaction.js run
# It may wait up to 6 h for live sessions to end.
TimeoutStartSec=7h
UNIT
cat >"$unit_dir/wsl-disk-compaction.timer" <<UNIT
[Unit]
Description=Daily check whether the WSL disk compaction is due (workflow-core#5044)

[Timer]
# Untraced: 02:00 is when sessions are likeliest to have drained.
OnCalendar=*-*-* 02:00
Persistent=true
# Untraced: a run waits up to 6 h anyway, so minutes of slip cost nothing.
AccuracySec=5min

[Install]
WantedBy=timers.target
UNIT
"$SYSTEMCTL" --user daemon-reload
"$SYSTEMCTL" --user enable --now wsl-disk-compaction.timer
"$SYSTEMCTL" --user is-active wsl-disk-compaction.timer

cat <<EOF

Installed. It checks every 2 minutes and stays silent unless a wedge is found.

  Activity log : %LOCALAPPDATA%\\wsl-interop-watchdog.log  (only written on a detection)
  Compaction   : %LOCALAPPDATA%\\wsl-compact.log; check with: node $repo/scripts/check-wsl-disk.js
  Remove with  : schtasks.exe /Delete /TN "$TASK_NAME" /F
                 schtasks.exe /Delete /TN "$COMPACT_TASK" /F
                 systemctl --user disable --now wsl-disk-compaction.timer
EOF
