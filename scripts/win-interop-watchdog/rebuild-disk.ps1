# Rebuilds the WSL disk to drop its fragmented dead space (#5041): archive the
# distro to C: with GNU tar and multi-threaded zstd, verify the archive reads
# back whole, then unregister and re-import at the same path, into a virtual
# disk capped at -CapGB (#5430): a dynamic VHDX never grows past its virtual
# size, however fragmented ext4 gets. The old disk is
# removed only after the archive has passed every check. A finished archive is
# never deleted by this script: a failed check or import stops and keeps it.
# Run from an administrator Windows PowerShell window, never from inside WSL,
# which it shuts down: copy it to C:\wsl-rebuild\ and run
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\wsl-rebuild\rebuild-disk.ps1
# Every Claude session is down for the run; the refill loop is paused while
# the archive is made, so nothing writes to the disk being copied.
# -Rehearsal archives -Source from -From into a throwaway -Distro, with no
# loop pause, shutdown, watchdog toggle, Defender change, default change, boot
# or prompt. It still sets defaultVhdSize in .wslconfig.
param(
	[string]$Distro = 'Ubuntu',
	[string]$From = 'Ubuntu',
	[string]$Source = '/',
	[string]$User = 'root',
	[string]$Base = 'C:\Users\lucmo\AppData\Local\wsl\Ubuntu',
	[string]$Dir = 'C:\wsl-rebuild',
	# A first guess: 5,631,570 entries on 12 Nov 2026, so under 2.5 million is a
	# truncated archive.
	[int]$MinEntries = 2500000,
	[string]$MustHold = 'home/lucmo/workflow-core/.git/HEAD',
	# #5428's ruling. A GB figure, not TB (microsoft/WSL#11535).
	[int]$CapGB = 224,
	# Untraced: a healthy archive grows every few seconds; one on a frozen VM
	# never resumed (#5430).
	[int]$StallMinutes = 3,
	[switch]$Rehearsal
)
$ErrorActionPreference = 'Continue'
$wslconfig = "$env:USERPROFILE\.wslconfig"
# An import into a disk too small for the data fails as "Unspecified error"
# (E_FAIL, ENOSPC inside; microsoft/WSL#11535). 85% leaves ext4's overhead and
# 5% root reserve room (untraced); check-wsl-disk.js's GUEST_FULL_SHARE is the
# same figure.
$fullShare = 0.85
$log = "$Dir\rebuild.log"; $tar = "$Dir\$Distro.tar.zst"; $list = "$Dir\list.txt"; $errs = "$Dir\tar-errors.txt"
$maker = "$Dir\make-archive.sh"; $status = "$tar.status"
$task = 'WSL Interop Watchdog'
$guest = { param($p) '/mnt/' + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }
$repo = '/home/lucmo/workflow-core'

Add-Type -Namespace Wfc -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
'@
# A click in the window starts QuickEdit selection, which pauses this script,
# and with it the free-space guard, until Esc: switch QuickEdit off.
$stdin = [Wfc.Native]::GetStdHandle(-10); $mode = [uint32]0
if ([Wfc.Native]::GetConsoleMode($stdin, [ref]$mode)) { $null = [Wfc.Native]::SetConsoleMode($stdin, [uint32](($mode -band 0xFFBF) -bor 0x80)) }
# Keep the machine awake for the run (ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
# Residual: a Windows Update restart still ends the run; the old disk survives it.
$null = [Wfc.Native]::SetThreadExecutionState([uint32]2147483649)

function L($m) { $line = "$(Get-Date -Format s) $m"; Add-Content -Path $log -Value $line; Write-Host $line }
function FreeGB { [math]::Round((Get-PSDrive C).Free / 1GB, 1) }
function GB($bytes) { [math]::Round($bytes / 1GB, 1) }
function SizeGB($p) { GB (Get-Item $p).Length }
# The length a writer has reached; the directory entry Get-Item reads can lag
# an open file's.
function LiveLength($p) {
	try { $f = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite, Delete'); try { $f.Length } finally { $f.Close() } }
	catch { 0 }
}
# node comes from nvm, which a shell Windows starts never loads on its own.
function Loop($flag) {
	wsl.exe -d $From -u lucmo -- bash -c ". ~/.nvm/nvm.sh && cd $repo && node scripts/refill-loop.js set $flag" | Out-Null
	$code = $LASTEXITCODE; L "refill loop: set $flag (exit $code)"; return $code
}
function LoopPaused {
	$s = wsl.exe -d $From -u lucmo -- bash -c ". ~/.nvm/nvm.sh && cd $repo && node scripts/refill-loop.js status"
	if ($LASTEXITCODE -ne 0) { L "refill loop status exited $LASTEXITCODE; nothing was changed"; Finish 1 }
	return [bool]($s -match '^paused ')
}
# Only a pause this run made is lifted at the end; a founder's pause stands.
$wePaused = $false

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$added = @()
# The watchdog is re-enabled only where this run disabled it.
$weDisabled = $false
# Set once wsl --shutdown hangs: every later wsl.exe call would hang with it.
$wslStuck = $false

# 0 rebuilt; 1 stopped before the archive finished, old disk intact;
# 2 import failed, archive kept; 3 a check failed, archive and old disk kept.
function Finish($code) {
	foreach ($x in $added) { Remove-MpPreference -ExclusionPath $x }
	if (-not $Rehearsal) {
		if ($code -ne 2) {
			if ($weDisabled) { Enable-ScheduledTask -TaskName $task | Out-Null }
			if ($wslStuck) { if ($wePaused) { L 'WSL is stuck: after restarting Windows, run node scripts/refill-loop.js set --resume' } }
			else {
				wsl.exe -d $Distro --exec /bin/true
				if ($wePaused) { $null = Loop '--resume' }
			}
		}
		else { L "the watchdog stays disabled until the import is done; then: Enable-ScheduledTask -TaskName '$task'" }
	}
	L "finished, code $code, C: free $(FreeGB) GB"
	if (-not $Rehearsal) { Read-Host 'Press Enter to close' }
	exit $code
}
function Keep($why) { L "STOPPED, archive and old disk kept: $why. Before a re-run, look at $tar and delete it."; Finish 3 }
# Untraced: a healthy wsl --shutdown takes seconds; a frozen VM can hold it
# for ever. StopWsl is true where it finished and exited 0.
$shutdownWaitSec = 120
function StopWsl {
	$s = Start-Process wsl.exe -ArgumentList '--shutdown' -PassThru -WindowStyle Hidden
	$null = $s.Handle
	if (-not $s.WaitForExit($shutdownWaitSec * 1000)) { $script:wslStuck = $true; L "wsl --shutdown did not finish in $shutdownWaitSec s; restart Windows before a re-run"; return $false }
	if ($s.ExitCode -ne 0) { L "wsl --shutdown exited $($s.ExitCode)"; return $false }
	return $true
}
# The distro's state from wsl -l -v (Running, Stopped, ...), or $null where
# it would not read.
function DistroState($name) {
	$rows = wsl.exe -l -v
	if ($LASTEXITCODE -ne 0) { return $null }
	foreach ($r in ($rows -replace "`0", '')) {
		$f = ($r -replace '^\*', '').Trim() -split '\s+'
		if ($f[0] -eq $name) { return $f[1] }
	}
	return $null
}
function Abort($why) {
	L "ABORT: $why"
	# Killing cmd.exe leaves wsl.exe, tar and zstd running.
	if ($Rehearsal) { wsl.exe --terminate $From } else { $null = StopWsl }
	Start-Sleep 5
	if (Test-Path $tar) {
		Remove-Item $tar -Force -ErrorAction SilentlyContinue
		if (Test-Path $tar) { L "$tar would not delete; delete it before a re-run" }
	}
	Finish 1
}
# Sets [wsl2] defaultVhdSize, which wsl --import obeys, the service re-reading
# .wslconfig on each import (WSL 3.0.5, LxssUserSession.cpp L1516, L1623-1630).
# The key stays, so a later re-import gets the same cap. A file that will not
# read is never rewritten: it holds the memory and swap limits.
function SetVhdSize {
	try { $lines = [Collections.Generic.List[string]]@(if (Test-Path $wslconfig) { Get-Content $wslconfig -ErrorAction Stop }) }
	catch { L "$wslconfig would not read ($($_.Exception.Message)); nothing was changed"; Finish 1 }
	$want = "defaultVhdSize=${CapGB}GB"
	$section = ''; $head = -1; $at = -1
	for ($i = 0; $i -lt $lines.Count; $i++) {
		$t = $lines[$i].Trim()
		if ($t -match '^\[(.+)\]$') { $section = $Matches[1].ToLower(); if ($section -eq 'wsl2') { $head = $i } }
		elseif ($section -eq 'wsl2' -and $t -match '^defaultVhdSize\s*=') { $at = $i }
	}
	if ($at -ge 0) { $lines[$at] = $want }
	elseif ($head -ge 0) { $lines.Insert($head + 1, $want) }
	else { $lines.Add('[wsl2]'); $lines.Add($want) }
	try { [IO.File]::WriteAllLines($wslconfig, $lines, (New-Object Text.UTF8Encoding $false)) }
	catch { L "$wslconfig would not write ($($_.Exception.Message)); nothing else was changed"; Finish 1 }
	if (-not (Select-String -Path $wslconfig -SimpleMatch $want -Quiet)) { L "$wslconfig lacks $want after writing it; nothing else was changed"; Finish 1 }
	L "$wslconfig sets $want"
}
function Magic($p) {
	$fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); $b = New-Object byte[] 4
	$null = $fs.Read($b, 0, 4); $fs.Close()
	return ($b[0] -eq 0x28 -and $b[1] -eq 0xB5 -and $b[2] -eq 0x2F -and $b[3] -eq 0xFD)
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
L "start, $Distro, ext4.vhdx $(SizeGB "$Base\ext4.vhdx") GB, C: free $(FreeGB) GB, elevated $admin"
if (Test-Path $tar) { L "an archive from an earlier run exists at $tar; check it by hand"; if (-not $Rehearsal) { Read-Host 'Press Enter' }; exit 1 }
Remove-Item $status, "$tar.tar-err" -ErrorAction SilentlyContinue
$used = (wsl.exe -d $From -u root -- df -B1 --output=used $Source | Select-Object -Last 1).Trim()
if ($used -notmatch '^\d+$') { L "df on $From would not read ($used); nothing was changed"; Finish 1 }
$usedGB = [math]::Round([double]$used / 1GB, 1)
if ([double]$used -gt $fullShare * $CapGB * 1GB) { L "$From uses $usedGB GB, over $($fullShare * 100)% of the $CapGB GB cap: free space in it, or raise -CapGB; nothing was changed"; Finish 1 }
L "$From uses $usedGB GB of the $CapGB GB cap"
SetVhdSize
# Defender scans every write to the archive and the new disk; exclude both
# folders for the run where this window is elevated, and only those this run added.
if ($admin -and -not $Rehearsal) {
	$have = @((Get-MpPreference).ExclusionPath)
	foreach ($x in @($Dir, $Base)) { if ($have -notcontains $x) { Add-MpPreference -ExclusionPath $x; $added += $x } }
	L "Defender exclusions added: $($added -join ', ')"
}
# A run cut off by a closed window, a sleep or a restart leaves these to undo.
L "IF THIS RUN IS CUT OFF: Enable-ScheduledTask -TaskName '$task'; Remove-MpPreference -ExclusionPath $($added -join ','); then, if wsl -l lists $Distro, start it and run in it: . ~/.nvm/nvm.sh && cd $repo && node scripts/refill-loop.js set --resume (skip that if the loop was paused before). If wsl -l lists nothing, run: wsl --import $Distro $Base $tar --version 2"

# GNU tar into zstd on all 8 cores, nothing else running. The archive leaves on
# stdout, which wsl.exe carries to Windows 3 times faster than writing it over
# /mnt/c (3 GB in 8.3 s against 25.3 s, 12 Nov 2026). tar exit 1 means a file
# changed while read, which the paused loop leaves to logs; exit 2 or a zstd
# failure is fatal. $2 names the archive, for the status and error files.
$sh = @'
#!/bin/bash
set -u
tar --one-file-system --numeric-owner --xattrs --xattrs-include='*' --acls \
	--warning=no-file-changed --warning=no-file-removed --warning=no-file-ignored \
	-cpf - -C "$1" . 2>"$2.tar-err" | /home/lucmo/miniforge3/bin/zstd -T8 -3 -q -c
s=("${PIPESTATUS[@]}")
echo "tar=${s[0]} zstd=${s[1]}" > "$2.status"
[ "${s[0]}" -le 1 ] && [ "${s[1]}" -eq 0 ]
'@
[IO.File]::WriteAllText($maker, ($sh -replace "`r", ''))

if (-not $Rehearsal) {
	if (LoopPaused) { L 'refill loop already paused; it stays paused after the run' }
	else {
		if ((Loop '--pause') -ne 0) { L 'the refill loop would not pause; nothing was changed'; Finish 1 }
		$wePaused = $true
	}
	if ((Get-ScheduledTask -TaskName $task).State -ne 'Disabled') {
		Disable-ScheduledTask -TaskName $task | Out-Null
		if ((Get-ScheduledTask -TaskName $task).State -ne 'Disabled') { L 'the watchdog task would not disable; nothing was changed'; Finish 1 }
		$weDisabled = $true
	}
	if (-not (StopWsl)) { Abort 'wsl --shutdown failed before the archive' }
	Start-Sleep 10
	# Boot again with launches paused. A boot that fails, as one did with
	# ERROR_TIMEOUT on a VM that then froze (#5430), stops the run.
	wsl.exe -d $From --exec /bin/true
	if ($LASTEXITCODE -ne 0) { Abort "booting $From exited $LASTEXITCODE" }
}

L "archiving $Source from $From"
$p = Start-Process cmd.exe -ArgumentList '/c', "wsl.exe -d $From -u $User -- bash $(& $guest $maker) $Source $(& $guest $tar) > `"$tar`"" -WorkingDirectory $Dir -PassThru -WindowStyle Hidden
$null = $p.Handle
$checked = $false; $tick = 0; $grewAt = Get-Date; $lastLen = -1
while (-not $p.HasExited) {
	Start-Sleep 15; $tick++
	$len = LiveLength $tar
	if ($len -gt $lastLen) { $lastLen = $len; $grewAt = Get-Date }
	elseif (((Get-Date) - $grewAt).TotalMinutes -ge $StallMinutes) { $p.Kill(); Abort "the archive has not grown in $StallMinutes minutes, at $(GB $lastLen) GB" }
	if (-not $checked -and $len -gt 1MB) {
		if (-not (Magic $tar)) { $p.Kill(); Abort 'the archive is not zstd' }
		$checked = $true; L 'archive is zstd'
	}
	if ((FreeGB) -lt 15) { $p.Kill(); Abort 'C: free fell under 15 GB while archiving' }
	if ($tick % 20 -eq 0) { L "archive $(GB $len) GB, C: free $(FreeGB) GB" }
}
$p.WaitForExit()
$st = if (Test-Path $status) { (Get-Content $status) -join ' ' } else { 'no status' }
if ($p.ExitCode -ne 0) { Keep "archiving exited $($p.ExitCode) ($st): $((Get-Content "$tar.tar-err" -ErrorAction SilentlyContinue | Select-Object -Last 5) -join ' | ')" }
if (-not (Test-Path $tar)) { Abort 'archiving wrote no archive' }
if (-not (Magic $tar)) { Keep 'the archive is not zstd' }
L "archived, $(SizeGB $tar) GB ($st)"

if (-not $Rehearsal) {
	if (-not (StopWsl)) { Keep 'wsl --shutdown failed after the archive was made' }
	Start-Sleep 5
}
L 'verifying: reading the whole archive back'
# Windows tar cannot name a file holding a tab or newline, which some test
# scratch does: it skips that name, exits 1, and has still read the stream to
# the end. Any other complaint is a damaged archive.
cmd.exe /c "tar.exe -tf `"$tar`" > `"$list`" 2> `"$errs`""
$tarExit = $LASTEXITCODE
$other = @(Get-Content $errs | Where-Object { $_ -notmatch 'empty or unreadable filename|Error exit delayed from previous errors' })
if ($tarExit -gt 1 -or $other.Count -gt 0) { Keep "the archive does not read back (tar exit $tarExit): $($other -join ' | ')" }
L "tar skipped $(@(Get-Content $errs | Select-String 'unreadable filename').Count) unnameable entries"
$n = 0; foreach ($x in [IO.File]::ReadLines($list)) { $n++ }
$head = Select-String -Path $list -SimpleMatch $MustHold -List
if ($n -lt $MinEntries) { Keep "the archive holds only $n entries" }
if (-not $head) { Keep "the archive lacks $MustHold" }
L "verified, $n entries"
Remove-Item $list, $errs

# VS Code or Explorer can boot the distro during the verify; its writes would
# be missing from the archive.
if (-not $Rehearsal) {
	$state = DistroState $Distro
	if ($null -eq $state) { Keep "wsl -l -v would not read $Distro's state" }
	if ($state -ne 'Stopped') { $null = StopWsl; Keep "something started $Distro after the archive was made" }
}
L "unregistering $Distro"
wsl.exe --unregister $Distro
if ($LASTEXITCODE -ne 0) { Keep "unregister exited $LASTEXITCODE; the old disk should be intact" }
if (Test-Path "$Base\ext4.vhdx") { L "ext4.vhdx is still there after unregister. Move it aside, then run: wsl --import $Distro $Base $tar --version 2"; Finish 2 }

L 'importing'
New-Item -ItemType Directory -Force -Path $Base | Out-Null
wsl.exe --import $Distro $Base $tar --version 2
if ($LASTEXITCODE -ne 0) { L "IMPORT FAILED (exit $LASTEXITCODE). The archive is kept at $tar. Re-run: wsl --import $Distro $Base $tar --version 2"; Finish 2 }
if (-not $Rehearsal) { wsl.exe --set-default $Distro }
L "imported, ext4.vhdx $(SizeGB "$Base\ext4.vhdx") GB; archive kept at $tar until checked from inside WSL"
# Get-VHD needs Hyper-V.
$virt = (wsl.exe -d $Distro -u root -- sh -c 'lsblk -bdno SIZE "$(findmnt -no SOURCE /)"' | Select-Object -Last 1)
if ($virt -match '^\s*(\d+)\s*$') {
	$virtGB = [math]::Round([double]$Matches[1] / 1GB, 1)
	if ($virtGB -eq $CapGB) { L "virtual size $virtGB GB, the cap" }
	else { L "VIRTUAL SIZE $virtGB GB, NOT THE $CapGB GB CAP: read $wslconfig; to fix, wsl --shutdown, then wsl --manage $Distro --resize ${CapGB}GB" }
}
else { L "the virtual size would not read ($virt); read it in WSL with: lsblk -b" }
Finish 0
