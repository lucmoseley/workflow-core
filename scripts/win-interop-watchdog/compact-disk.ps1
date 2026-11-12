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
# check-wsl-disk.js reads: `ok`, `failed` or, from the WSL side, `deferred`.
param(
	[string]$Distro = 'Ubuntu',
	[string]$Vhdx = "$env:LOCALAPPDATA\wsl\Ubuntu\ext4.vhdx",
	# Where the hold is released after the boot: the WSL user and the checkout
	# whose refill-loop.js set it.
	[string]$WslUser = '',
	[string]$Repo = '',
	[switch]$Register
)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:LOCALAPPDATA 'wsl-compact.log'
$self = 'WSL Disk Compaction'
$watchdog = 'WSL Interop Watchdog'

function L($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }
function GB($bytes) { [math]::Round($bytes / 1GB, 1) }
function FreeGB { GB (Get-PSDrive C).Free }

if ($Register) {
	$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Distro `"$Distro`" -WslUser `"$WslUser`" -Repo `"$Repo`""
	$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
	$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
	$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
	$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
	Register-ScheduledTask -TaskName $self -Action $action -Principal $principal -Settings $settings -Force `
		-Description 'Compacts the WSL disk with diskpart (workflow-core #5044). Started only by wsl-disk-compaction.js once no session is live, because it runs wsl --shutdown.' | Out-Null
	if (-not (Test-Path $log)) { L "registered size_gb=$(GB (Get-Item $Vhdx).Length) c_free_gb=$(FreeGB)" }
	Write-Host "Registered '$self'. Log: $log"
	exit 0
}

function DiskPart([string[]]$lines) {
	$script = Join-Path $env:TEMP 'wsl-compact.diskpart'
	Set-Content -Path $script -Value $lines -Encoding ASCII
	$out = (diskpart.exe /s $script 2>&1) -join ' '
	$code = $LASTEXITCODE
	Remove-Item $script -ErrorAction SilentlyContinue
	return @{ code = $code; out = $out }
}

$before = (Get-Item $Vhdx).Length
$weDisabled = $false
$result = $null
try {
	# The watchdog boots WSL when it is down, which would hold the disk open.
	if ((Get-ScheduledTask -TaskName $watchdog).State -ne 'Disabled') {
		Disable-ScheduledTask -TaskName $watchdog | Out-Null
		$weDisabled = $true
	}
	# A run already started finishes within its 2-minute limit.
	for ($i = 0; $i -lt 30 -and (Get-ScheduledTask -TaskName $watchdog).State -eq 'Running'; $i++) { Start-Sleep 5 }
	wsl.exe --shutdown
	Start-Sleep 10
	# diskpart stops at the first failing command, so a failed compact would
	# leave the disk attached and WSL unable to boot: detach on its own after.
	$dp = DiskPart @("select vdisk file=`"$Vhdx`"", 'attach vdisk readonly', 'compact vdisk', 'detach vdisk')
	if ($dp.code -ne 0) {
		$null = DiskPart @("select vdisk file=`"$Vhdx`"", 'detach vdisk')
		$result = "failed step=diskpart exit=$($dp.code) size_gb=$(GB $before) c_free_gb=$(FreeGB) out=$($dp.out -replace '\s+', ' ')"
	}
	else {
		$result = "ok before_gb=$(GB $before) after_gb=$(GB (Get-Item $Vhdx).Length) c_free_gb=$(FreeGB)"
	}
}
catch {
	$result = "failed step=script error=$($_.Exception.Message -replace '\s+', ' ')"
}
finally {
	if ($weDisabled) { Enable-ScheduledTask -TaskName $watchdog | Out-Null }
	wsl.exe -d $Distro --exec /bin/true
	if ($WslUser -and $Repo) {
		# node comes from nvm, which a shell Windows starts never loads on its own.
		wsl.exe -d $Distro -u $WslUser -- bash -c "[ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; cd '$Repo' && node scripts/refill-loop.js set --release-launches" | Out-Null
	}
	if ($null -eq $result) { $result = 'failed step=script error=ended before a result' }
	L $result
}
