# Turns page combining on or off and takes a live kernel dump, for the
# combining-on nights of #5743's Driver Verifier pass (#5804). Each act needs
# an administrator, so each runs as an elevated task that
# scripts/combining-trial.js, on the WSL side, starts unelevated with
# `schtasks /Run`:
#   'Verifier 5743 combining on'  -Action On
#   'Verifier 5743 combining off' -Action Off
#   'Verifier 5743 live dump'     -Action Dump
# -Register registers the three and makes on-bugcheck.ps1 turn combining off
# on the boot after a crash. It must be run elevated, which
# scripts/install-combining-trial.sh asks for. -Check, unelevated, prints
# `ok` where all of that is in place, else what is missing.
# On and Off append `<time> <on|off> PageCombining=<True|False>` to
# combining.log; Dump appends `<time> ok path=<file> bytes=<n>` or
# `<time> failed ...` to dumps.log. combining-trial.js reads both.
param(
	[ValidateSet('On', 'Off', 'Dump')][string]$Action,
	[switch]$Register,
	[switch]$Check
)
$ErrorActionPreference = 'Stop'
$dir = 'C:\diag\5743'
$combiningLog = Join-Path $dir 'combining.log'
$dumpsLog = Join-Path $dir 'dumps.log'
$bugcheck = Join-Path $dir 'on-bugcheck.ps1'
$bugcheckMarker = '# Page combining off after a crash (#5804).'
$tasks = [ordered]@{
	'Verifier 5743 combining on'  = 'On'
	'Verifier 5743 combining off' = 'Off'
	'Verifier 5743 live dump'     = 'Dump'
}

function Get-TaskArgs([string]$act) {
	"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Action $act"
}
function Write-Line([string]$log, [string]$m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }

function Get-Missing {
	$missing = @()
	foreach ($name in $tasks.Keys) {
		$t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
		if (-not $t -or $t.Actions[0].Arguments -ne (Get-TaskArgs $tasks[$name])) { $missing += "task '$name'" }
	}
	if (-not (Test-Path $bugcheck) -or -not (Select-String -Path $bugcheck -SimpleMatch $bugcheckMarker -Quiet)) {
		$missing += "the combining-off step in $bugcheck"
	}
	return $missing
}

if ($Check) {
	$missing = @(Get-Missing)
	if ($missing.Count -eq 0) { Write-Output 'ok' } else { Write-Output "missing: $($missing -join '; ')" }
	exit 0
}

if ($Register) {
	New-Item -ItemType Directory -Force -Path (Join-Path $dir 'dumps') | Out-Null
	$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
	# Interactive, as 'WSL Disk Compaction': it runs only while the user is
	# signed in, which is when WSL and its timers run, and stores no password.
	$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
	foreach ($name in $tasks.Keys) {
		$act = $tasks[$name]
		$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (Get-TaskArgs $act)
		# Untraced: a 2.3 GB kernel dump (#5735) is written in minutes; an hour bounds a stuck one.
		$limit = if ($act -eq 'Dump') { New-TimeSpan -Hours 1 } else { New-TimeSpan -Minutes 10 }
		$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit $limit -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
		Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force `
			-Description "workflow-core#5804: $act, started by combining-trial.js through schtasks /Run." | Out-Null
	}
	if (-not (Select-String -Path $bugcheck -SimpleMatch $bugcheckMarker -Quiet)) {
		# First in the file, so a later failing line cannot skip it.
		$step = @(
			$bugcheckMarker
			'Disable-MMAgent -PageCombining -ErrorAction SilentlyContinue'
			"`"`$(Get-Date -Format s) off PageCombining=`$((Get-MMAgent).PageCombining) after=bugcheck`" | Add-Content '$combiningLog'"
		)
		Set-Content -Path $bugcheck -Value ($step + (Get-Content $bugcheck)) -Encoding UTF8
	}
	$missing = @(Get-Missing)
	if ($missing.Count -gt 0) { Write-Error "still missing: $($missing -join '; ')" }
	Write-Host "Registered: $($tasks.Keys -join ', '). Logs: $combiningLog, $dumpsLog"
	exit 0
}

switch ($Action) {
	'On' {
		Enable-MMAgent -PageCombining
		Write-Line $combiningLog "on PageCombining=$((Get-MMAgent).PageCombining)"
	}
	'Off' {
		Disable-MMAgent -PageCombining
		Write-Line $combiningLog "off PageCombining=$((Get-MMAgent).PageCombining)"
	}
	'Dump' {
		# The call Task Manager's "Create live kernel memory dump file" makes:
		# NtSystemDebugControl(SysDbgGetLiveKernelDump = 37) with a version-1
		# SYSDBG_LIVEDUMP_CONTROL, layout from System Informer's phnt
		# (ntexapi.h). No selective control, so a full kernel dump without user
		# pages; flag bit 3 is AbortIfMemoryPressure, Task Manager's default.
		Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Wfc5804LiveDump {
	[StructLayout(LayoutKind.Sequential)]
	public struct Control {
		public uint Version; public uint BugCheckCode;
		public UIntPtr Param1; public UIntPtr Param2; public UIntPtr Param3; public UIntPtr Param4;
		public IntPtr DumpFileHandle; public IntPtr CancelEventHandle;
		public uint Flags; public uint AddPagesControl;
	}
	[DllImport("ntdll.dll")]
	public static extern int RtlAdjustPrivilege(int privilege, bool enable, bool currentThread, out bool wasEnabled);
	[DllImport("ntdll.dll")]
	public static extern int NtSystemDebugControl(int command, ref Control input, int inputLength, IntPtr output, int outputLength, out int returnLength);
}
'@
		$path = Join-Path $dir ("dumps\live-{0}.dmp" -f (Get-Date -Format 'yyMMdd-HHmm'))
		$was = $false
		# 20 is SE_DEBUG_PRIVILEGE, which the elevated token holds disabled.
		$priv = [Wfc5804LiveDump]::RtlAdjustPrivilege(20, $true, $false, [ref]$was)
		if ($priv -ne 0) { Write-Line $dumpsLog ('failed step=privilege status=0x{0:X8}' -f $priv); exit 1 }
		$file = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
		try {
			$ctl = New-Object Wfc5804LiveDump+Control
			$ctl.Version = 1
			# LIVE_SYSTEM_DUMP, the code Task Manager's dumps carry.
			$ctl.BugCheckCode = 0x161
			$ctl.DumpFileHandle = $file.SafeFileHandle.DangerousGetHandle()
			$ctl.Flags = 0x8
			$ret = 0
			$status = [Wfc5804LiveDump]::NtSystemDebugControl(37, [ref]$ctl, [Runtime.InteropServices.Marshal]::SizeOf($ctl), [IntPtr]::Zero, 0, [ref]$ret)
		}
		finally { $file.Close() }
		$bytes = (Get-Item $path).Length
		if ($status -ne 0 -or $bytes -eq 0) {
			Remove-Item $path -ErrorAction SilentlyContinue
			Write-Line $dumpsLog ('failed step=dump status=0x{0:X8} bytes={1}' -f $status, $bytes)
			exit 1
		}
		Write-Line $dumpsLog "ok path=$path bytes=$bytes"
	}
	default { Write-Error 'give -Action On|Off|Dump, -Register or -Check' }
}
