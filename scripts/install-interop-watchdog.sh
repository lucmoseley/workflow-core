#!/usr/bin/env bash
# Installs the Windows-side WSL interop watchdog. Idempotent: safe to re-run,
# and re-running is how you deploy a change to watchdog.ps1.
#
# WHAT IT INSTALLS
#   C:\Users\<you>\wsl-interop-watchdog\{watchdog.ps1,launcher.vbs,task.xml}
#   Scheduled task "WSL Interop Watchdog" - at logon + every 2 minutes.
#   C:\Users\<you>\wsl-interop-watchdog\compact-disk.ps1
#   Scheduled task "WSL Disk Compaction" - elevated, no trigger (#5044):
#     registered with one UAC prompt where it is absent.
#   User timer wsl-disk-compaction.timer - daily at 02:00, runs
#     scripts/wsl-disk-compaction.js run, which starts that task once due and
#     no session is live.
#
# The task never runs `wsl --shutdown`: a false positive would kill live
# background Claude sessions, which is worse than the fault it guards. It does
# boot the default distro when the VM is down (launcher.vbs). See
# docs/environment.md §9 for the incident, the recovery and the keep-alive.
#
# The companion shell-side guard is scripts/claude-interop-guard.sh, sourced
# from ~/.bashrc. That one stops a doomed launch; this one catches a wedge that
# happens mid-session, when no new launch is coming.

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

# Identity of the Windows user this task runs as.
win_user="$(/mnt/c/Windows/System32/whoami.exe | tr -d '\r')"
win_sid="$("$PS" -NoProfile -Command \
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value' | tr -d '\r')"
win_profile="$("$PS" -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"

install_win="${win_profile}\\wsl-interop-watchdog"
# Translate the Windows profile path to something WSL can write to.
install_wsl="$("$PS" -NoProfile -Command '$env:USERPROFILE' | tr -d '\r' |
  sed -e 's|\\|/|g' -e 's|^\([A-Za-z]\):|/mnt/\L\1|')/wsl-interop-watchdog"

echo "Windows user : $win_user"
echo "Install dir  : $install_win"

mkdir -p "$install_wsl"
cp "$SRC_DIR/watchdog.ps1" "$SRC_DIR/launcher.vbs" "$SRC_DIR/compact-disk.ps1" "$install_wsl/"

# Fill the task template with this machine's identity and install path.
tmp_xml="$(mktemp)"
trap 'rm -f "$tmp_xml"' EXIT
# Backslashes must be doubled in a sed replacement, or GNU sed reads DOMAIN\user
# as an escape sequence and silently eats the separator (\l lowercases instead).
sed -e "s|@@USERDOMAINUSER@@|${win_user//\\/\\\\}|" \
  -e "s|@@USERSID@@|${win_sid}|" \
  -e "s|@@INSTALLDIR@@|${install_win//\\/\\\\}|" \
  "$SRC_DIR/task.xml.template" >"$tmp_xml"

# schtasks requires the definition as UTF-16LE with a BOM.
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

# --- the monthly disk compaction (#5044) ------------------------------------

COMPACT_TASK='WSL Disk Compaction'
# The main checkout, never a linked worktree a prune would delete.
repo="$(cd "$SRC_DIR/../.." && git rev-parse --path-format=absolute --git-common-dir)"
repo="${repo%/.git}"
if ! "$SCHTASKS" /Query /TN "$COMPACT_TASK" >/dev/null 2>&1; then
  echo "Registering '$COMPACT_TASK' elevated: accept the UAC prompt on the Windows desktop."
  "$PS" -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${install_win}\\compact-disk.ps1','-Register','-WslUser','$USER','-Repo','$repo'"
  "$SCHTASKS" /Query /TN "$COMPACT_TASK" >/dev/null 2>&1 || {
    echo "error: '$COMPACT_TASK' is not registered - was the UAC prompt declined?" >&2
    exit 1
  }
fi

node_bin="$(command -v node)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat >"$unit_dir/wsl-disk-compaction.service" <<UNIT
[Unit]
Description=Start the monthly WSL disk compaction once due and no session is live (workflow-core #5044)

[Service]
Type=oneshot
ExecStart=$node_bin $repo/scripts/wsl-disk-compaction.js run
# It may wait up to 6 h for live sessions to end.
TimeoutStartSec=7h
UNIT
cat >"$unit_dir/wsl-disk-compaction.timer" <<UNIT
[Unit]
Description=Daily check whether the WSL disk compaction is due (workflow-core #5044)

[Timer]
# Untraced: 02:00 is when sessions are likeliest to have drained.
OnCalendar=*-*-* 02:00
Persistent=true
AccuracySec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now wsl-disk-compaction.timer
systemctl --user is-active wsl-disk-compaction.timer

cat <<EOF

Installed. It checks every 2 minutes and stays silent unless a wedge is found.

  Activity log : %LOCALAPPDATA%\\wsl-interop-watchdog.log  (only written on a detection)
  Compaction   : %LOCALAPPDATA%\\wsl-compact.log; check with: npm run check:wsl-disk
  Remove with  : schtasks.exe /Delete /TN "$TASK_NAME" /F
EOF
