#!/usr/bin/env bash
# Installs the Windows-side WSL interop watchdog. Idempotent: safe to re-run,
# and re-running is how you deploy a change to watchdog.ps1.
#
# WHAT IT INSTALLS
#   C:\Users\<you>\wsl-interop-watchdog\{watchdog.ps1,launcher.vbs,task.xml}
#   Scheduled task "WSL Interop Watchdog" - at logon + every 2 minutes.
#
# The task DETECTS AND NOTIFIES ONLY. It never runs `wsl --shutdown`: a false
# positive would kill live background Claude sessions, which is worse than the
# fault it guards. See docs/environment.md for the incident and the recovery.
#
# The companion shell-side guard is scripts/claude-interop-guard.sh, sourced
# from ~/.bashrc. That one stops a doomed launch; this one catches a wedge that
# happens mid-session, when no new launch is coming.

set -euo pipefail

TASK_NAME='WSL Interop Watchdog'
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/win-interop-watchdog" && pwd)"
PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
SCHTASKS='/mnt/c/Windows/System32/schtasks.exe'

[ -x "$PS" ] || {
  echo "error: Windows PowerShell not reachable - is this WSL with interop enabled?" >&2
  exit 1
}
[ -x "$SCHTASKS" ] || {
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
cp "$SRC_DIR/watchdog.ps1" "$SRC_DIR/launcher.vbs" "$install_wsl/"

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

cat <<EOF

Installed. It checks every 2 minutes and stays silent unless a wedge is found.

  Activity log : %LOCALAPPDATA%\\wsl-interop-watchdog.log  (only written on a detection)
  Remove with  : schtasks.exe /Delete /TN "$TASK_NAME" /F
EOF
