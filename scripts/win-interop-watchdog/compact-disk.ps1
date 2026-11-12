# Compacts the WSL disk (#5044): shut WSL down, have diskpart drop the blocks
# the guest has trimmed from ext4.vhdx, then boot WSL again.
# It runs as the elevated task "WSL Disk Compaction", which has no trigger of
# its own: `scripts/wsl-disk-compaction.js run`, on the WSL side, holds
# launches, waits until no session is live, trims, then starts it, since
# `wsl --shutdown` kills every session.
# -Register registers that task. It must be run elevated, which
# scripts/install-interop-watchdog.sh asks for with one UAC prompt. Where no
# log exists yet, it writes the `registered` line the 30-day count starts from.
# Every run appends one result line to %LOCALAPPDATA%\wsl-compact.log, which
# check-wsl-disk.js reads: `ok` or `failed`, or from the WSL side `deferred`,
# `trimfailed`, `watched` or `watchfailed`.
param(
	[string]$Distro = 'Ubuntu',
	[string]$Vhdx = "$env:LOCALAPPDATA\wsl\Ubuntu\ext4.vhdx",
	# Where the hold is released after the boot: the WSL user and the checkout
	# whose refill-loop.js set it.
	[string]$WslUser = '',
	[string]$Repo = '',
	[switch]$Register,
	[switch]$PrintArgs
)
# A failing step must still reach `finally`, which deletes the marker and
# boots WSL: errors are read off each call's result, never thrown.
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:LOCALAPPDATA 'wsl-compact.log'
$self = 'WSL Disk Compaction'
# launcher.vbs boots no WSL while this is fresh, which would hold the disk open.
$marker = Join-Path $env:LOCALAPPDATA 'wsl-compact.running'

function Write-CompactLog($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }
# GiB, as the WSL side reads C: (lib/wsl-disk.js).
function ConvertTo-GB($bytes) { [math]::Round($bytes / 1GB, 1) }
function Get-FreeGB { ConvertTo-GB (Get-PSDrive C).Free }

$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Distro `"$Distro`" -WslUser `"$WslUser`" -Repo `"$Repo`""
# The installer re-registers where the registered arguments differ from these.
if ($PrintArgs) { Write-Output $taskArgs; exit 0 }
if ($Register) {
	$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
	$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
	# Interactive: it runs only while the user is signed in, which is when WSL
	# and its starter run, and it stores no password.
	$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
	# Untraced: a compaction was guessed at 10-15 minutes (#5041). A run killed
	# at this limit leaves the marker, which launcher.vbs boots past.
	$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
	Register-ScheduledTask -TaskName $self -Action $action -Principal $principal -Settings $settings -Force `
		-Description 'Compacts the WSL disk with diskpart (workflow-core #5044). Started only by wsl-disk-compaction.js once no session is live, because it runs wsl --shutdown.' | Out-Null
	if (-not (Test-Path $log)) { Write-CompactLog "registered size_gb=$(ConvertTo-GB (Get-Item $Vhdx).Length) c_free_gb=$(Get-FreeGB)" }
	Write-Host "Registered '$self'. Log: $log"
	exit 0
}

function Invoke-DiskPart([string[]]$lines) {
	$script = Join-Path $env:TEMP 'wsl-compact.diskpart'
	Set-Content -Path $script -Value $lines -Encoding ASCII
	$out = (diskpart.exe /s $script 2>&1) -join ' '
	$code = $LASTEXITCODE
	Remove-Item $script -ErrorAction SilentlyContinue
	return @{ code = $code; out = $out }
}

# The VM's process, which launcher.vbs reads too: it outlives wsl.exe's return.
function Test-WslRunning { [bool](Get-Process -Name vmmemWSL -ErrorAction SilentlyContinue) }

$detach = @("select vdisk file=`"$Vhdx`"", 'detach vdisk')
$before = (Get-Item $Vhdx).Length
$result = $null
try {
	Set-Content -Path $marker -Value (Get-Date -Format s)
	wsl.exe --shutdown
	# Untraced: a minute for the VM to stop.
	for ($i = 0; $i -lt 30 -and (Test-WslRunning); $i++) { Start-Sleep 2 }
	if (Test-WslRunning) {
		$result = "failed step=shutdown size_gb=$(ConvertTo-GB $before) c_free_gb=$(Get-FreeGB)"
	}
	else {
		# An earlier run killed mid-compact may have left it attached.
		$null = Invoke-DiskPart $detach
		# diskpart stops at the first failing command, so a failed compact would
		# leave the disk attached and WSL unable to boot: detach on its own after.
		$dp = Invoke-DiskPart @("select vdisk file=`"$Vhdx`"", 'attach vdisk readonly', 'compact vdisk', 'detach vdisk')
		if ($dp.code -ne 0) {
			$null = Invoke-DiskPart $detach
			$result = "failed step=diskpart exit=$($dp.code) size_gb=$(ConvertTo-GB $before) c_free_gb=$(Get-FreeGB) out=$($dp.out -replace '\s+', '_')"
		}
		else {
			$result = "ok before_gb=$(ConvertTo-GB $before) after_gb=$(ConvertTo-GB (Get-Item $Vhdx).Length) c_free_gb=$(Get-FreeGB)"
		}
	}
}
catch {
	$result = "failed step=script error=$($_.Exception.Message -replace '\s+', '_')"
}
finally {
	Remove-Item $marker -ErrorAction SilentlyContinue
	wsl.exe -d $Distro --exec /bin/true
	if ($null -eq $result) { $result = 'failed step=script error=ended_before_a_result' }
	if ($WslUser -and $Repo) {
		# node comes from nvm, which a shell Windows starts never loads on its
		# own; the holder is the one wsl-disk-compaction.js held under.
		$release = 'export CLAUDE_CODE_SESSION_ID=wsl-disk-compaction; [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; node scripts/refill-loop.js set --release-launches'
		$null = wsl.exe -d $Distro -u $WslUser --cd $Repo -- bash -c $release
		# Untraced: one retry, for a distro still finishing its boot.
		if ($LASTEXITCODE -ne 0) {
			Start-Sleep 30
			$null = wsl.exe -d $Distro -u $WslUser --cd $Repo -- bash -c $release
		}
		# The hold lapses on its own within the hour; the exit is logged.
		$result = "$result release_exit=$LASTEXITCODE"
	}
	Write-CompactLog $result
}
